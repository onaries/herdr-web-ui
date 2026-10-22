import { join } from "node:path";
import { MAX_PREFERENCES_BYTES, normalizeThemeChange, sharedPreferencesBody, type PreferencesChange, type SharedPreferences } from "../shared/preferences.ts";
import { badRequest, isJsonObject, jsonResponse } from "./http.ts";
import { damagedCopy, readStateDocument, writeStateDocument } from "./state-document.ts";

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/** The document a change would make is over MAX_PREFERENCES_BYTES; nothing was kept. */
export class PreferencesTooLarge extends Error {
  constructor() { super(`Shared preferences are at most ${MAX_PREFERENCES_BYTES / 1024} KB`); }
}

/**
 * The preferences every browser of this server shares (shared/preferences.ts), kept in the state
 * directory beside devices.json. One document: a browser sends the settings it changed (and the
 * pins when they changed), laid over what is held, last write wins per setting; the others take
 * the whole document from the event. A change is held, and told, only once it is on disk.
 */
export class PreferenceStore {
  private current: SharedPreferences = { revision: 0, settings: {} };
  private readonly path: string;
  private readonly listeners = new Set<(preferences: SharedPreferences) => void>();
  /** Until this store has replaced the file, a write reads it again first: it may have been damaged or repaired since. */
  private unsettled = true;

  constructor(stateDir: string) {
    this.path = join(stateDir, "preferences.json");
    try {
      const held = this.readDisk();
      if (held) this.current = held;
    } catch (error) {
      // a missing file is a server that has shared nothing yet; an unreadable one is not, and is never written over
      console.error(`Cannot read ${this.path} (${(error as NodeJS.ErrnoException).code ?? "error"}); shared preferences start empty and are not saved until it can be read`);
    }
  }

  /** The document on disk: undefined when there is none, null when it is damaged. Throws when it cannot be read. */
  private readDisk(): SharedPreferences | null | undefined {
    const read = readStateDocument(this.path);
    if (read.kind === "missing") return undefined;
    const parsed = read.kind === "json" ? read.value : undefined;
    const body = sharedPreferencesBody(parsed);
    if (body === null) {
      console.error(`${this.path} is ${read.kind === "malformed" ? "not JSON" : "not a preferences document"}; the next change keeps it as ${damagedCopy(this.path)}`);
      return null;
    }
    const revision = isJsonObject(parsed) && Number.isSafeInteger(parsed["revision"]) ? parsed["revision"] as number : 0;
    return { revision: Math.max(0, revision), settings: body.settings, ...(body.pins === undefined ? {} : { pins: body.pins }) };
  }

  get(): SharedPreferences { return this.current; }

  set(change: PreferencesChange): SharedPreferences {
    let base = this.current;
    let keepDamaged = false;
    if (this.unsettled) {
      // the file as it is now, not as it was at start: a repair is kept and the change laid over it
      const held = this.readDisk();
      if (held) base = held;
      keepDamaged = held === null;
    }
    change = normalizeThemeChange(base.settings, change);
    const pins = change.pins ?? base.pins;
    const next: SharedPreferences = { revision: base.revision + 1, settings: { ...base.settings, ...change.settings }, ...(pins === undefined ? {} : { pins }) };
    const text = `${JSON.stringify(next, null, 2)}\n`;
    if (byteLength(JSON.stringify(next)) > MAX_PREFERENCES_BYTES) throw new PreferencesTooLarge();
    writeStateDocument(this.path, text, keepDamaged);
    this.unsettled = false;
    this.current = next;
    for (const listener of [...this.listeners]) listener(this.current);
    return this.current;
  }

  subscribe(listener: (preferences: SharedPreferences) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

/** /api/preferences: GET the shared document, PUT a change to it. A watching device's PUT is refused before this (index.ts). */
export async function handlePreferencesRequest(request: Request, store: PreferenceStore): Promise<Response> {
  const reply = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });
  const tooLarge = () => reply({ error: { code: "too_large", message: new PreferencesTooLarge().message } }, 413);
  if (request.method === "GET") return reply(store.get());
  if (request.method !== "PUT") return reply({ error: { code: "method_not_allowed", message: "Use GET or PUT /api/preferences" } }, 405);
  // a body announced over the limit is refused unread; one that lies about its length is measured
  const announced = Number(request.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > MAX_PREFERENCES_BYTES) return tooLarge();
  const text = await request.text();
  if (byteLength(text) > MAX_PREFERENCES_BYTES) return tooLarge();
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return badRequest("invalid_json", "The body is not JSON"); }
  const body = sharedPreferencesBody(raw);
  if (body === null) return badRequest("invalid_body", "Send { settings: object, pins?: string[] }");
  try { return reply(store.set(body)); }
  catch (error) {
    if (error instanceof PreferencesTooLarge) return tooLarge();
    return reply({ error: { code: "preferences_unwritable", message: error instanceof Error ? error.message : String(error) } }, 500);
  }
}
