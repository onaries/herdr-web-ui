/**
 * The receiver of herdr web ui's anonymous install and update counts (server/telemetry.ts).
 * A Cloudflare Worker over one D1 table. It never reads the visitor's address or any header
 * beyond the content type; of where a request came from it keeps the country Cloudflare names
 * and nothing finer. It keeps the day rather than the time, and stores each
 * (install, event, version) once, so a replayed event counts once. It stores only the app's
 * validated, allowlisted settings snapshot. Deploy: telemetry/README.md.
 */

import { telemetrySettings, type TelemetrySettings } from "../shared/telemetry.ts";

/** the part of Cloudflare's D1 binding this Worker uses */
interface D1Statement { bind(...values: unknown[]): { run(): Promise<unknown> } }
export interface Env { DB: { prepare(query: string): D1Statement } }

export interface StoredEvent {
  day: string;
  event: "install" | "update";
  install_id: string;
  version: string;
  previous_version: string | null;
  os: string;
  arch: string;
  install_method: "plugin" | "managed" | "source";
  /** complete validated snapshot, or null when the sender has not provided one */
  settings: TelemetrySettings | null;
}

const MAX_BODY_BYTES = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** a release, or a prerelease of one (0.5.0-rc.1): the sender reports package.json's version as it is */
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9a-z.]{1,24})?$/;
const WORD = /^[a-z0-9_]{1,16}$/;
const EVENTS = new Set(["install", "update"]);
const METHODS = new Set(["plugin", "managed", "source"]);
/** ISO 3166-1 alpha-2 */
const COUNTRY = /^[A-Z]{2}$/;

/**
 * The country Cloudflare worked out for this request; null off Cloudflare or when it names none.
 * Its two non-countries are dropped too: XX (unknown), and T1, which would say the sender uses Tor.
 */
export function requestCountry(request: Request): string | null {
  const country = (request as { cf?: { country?: unknown } }).cf?.country;
  return typeof country === "string" && COUNTRY.test(country) && country !== "XX" ? country : null;
}

/** the event as it is stored, or null when the body is not one */
/** the fields an event has ever carried; `changed_settings` is what senders before 0.4.9 told and is not kept */
const EVENT_KEYS = new Set(["event", "install_id", "version", "previous_version", "os", "arch", "install_method", "settings", "changed_settings"]);

export function readEvent(body: unknown, now: Date): StoredEvent | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some((key) => !EVENT_KEYS.has(key))) return null;
  const { event, install_id, version, previous_version, os, arch, install_method } = value;
  if (typeof event !== "string" || !EVENTS.has(event)) return null;
  if (typeof install_id !== "string" || !UUID.test(install_id)) return null;
  if (typeof version !== "string" || !VERSION.test(version)) return null;
  if (previous_version !== null && (typeof previous_version !== "string" || !VERSION.test(previous_version))) return null;
  if (event === "install" && previous_version !== null) return null;
  if (typeof os !== "string" || !WORD.test(os) || typeof arch !== "string" || !WORD.test(arch)) return null;
  if (typeof install_method !== "string" || !METHODS.has(install_method)) return null;
  const hasSettings = Object.prototype.hasOwnProperty.call(value, "settings");
  const settingsValue = hasSettings ? value["settings"] : null;
  const settings = settingsValue === null ? null : telemetrySettings(settingsValue);
  if (hasSettings && settingsValue !== null && settings === null) return null;
  return {
    day: now.toISOString().slice(0, 10),
    event: event as StoredEvent["event"], install_id, version, previous_version, os, arch,
    install_method: install_method as StoredEvent["install_method"],
    settings,
  };
}

/** the body as text, or null as soon as it passes MAX_BODY_BYTES (without waiting for the rest) */
async function readBody(request: Request): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) { void reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export async function handle(request: Request, env: Env, now = new Date()): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/v1/events") return new Response(null, { status: 404 });
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  if (!request.headers.get("content-type")?.startsWith("application/json")) return new Response(null, { status: 415 });
  const text = await readBody(request);
  if (text === null) return new Response(null, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(text); } catch { return new Response(null, { status: 400 }); }
  const stored = readEvent(body, now);
  if (!stored) return new Response(null, { status: 400 });
  const settings = stored.settings === null ? null : JSON.stringify(stored.settings);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO events (day, event, install_id, version, previous_version, os, arch, install_method, country, settings) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(stored.day, stored.event, stored.install_id, stored.version, stored.previous_version, stored.os, stored.arch, stored.install_method, requestCountry(request), settings).run();
  return new Response(null, { status: 204 });
}

export default { fetch: (request: Request, env: Env) => handle(request, env) };
