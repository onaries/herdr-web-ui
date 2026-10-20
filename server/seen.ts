import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MAX_SEEN, MAX_SEEN_BYTES, mergeSeen, seenFinishBody, seenFinishKey, type SeenFinish } from "../shared/seen.ts";
import { badRequest, jsonResponse } from "./http.ts";

/**
 * The finishes some browser of this server presented (shared/seen.ts), kept in the state directory
 * beside preferences.json, so a finish read on the phone is read on the desktop too. A change is
 * held, and told, only once it is on disk.
 */
export class SeenStore {
  /** insertion order is write order: the first entries are the oldest */
  private readonly finishes = new Map<string, SeenFinish>();
  private readonly path: string;
  private readonly listeners = new Set<(finish: SeenFinish) => void>();

  constructor(stateDir: string) {
    this.path = join(stateDir, "seen.json");
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      for (const raw of Array.isArray(parsed) ? parsed : []) {
        const finish = seenFinishBody(raw);
        if (finish) this.finishes.set(seenFinishKey(finish), finish);
      }
    } catch (error) {
      // a missing file is a server that has recorded nothing yet; a damaged one is replaced by the next write
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Cannot read ${this.path}; read finishes start empty`);
    }
  }

  list(): SeenFinish[] { return [...this.finishes.values()]; }

  record(finish: SeenFinish): SeenFinish {
    const key = seenFinishKey(finish);
    const held = this.finishes.get(key);
    const next = mergeSeen(held, finish);
    if (!next) return held!;
    const finishes = new Map(this.finishes);
    finishes.delete(key);
    finishes.set(key, next);
    for (const old of finishes.keys()) {
      if (finishes.size <= MAX_SEEN) break;
      finishes.delete(old);
    }
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify([...finishes.values()])}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
    this.finishes.clear();
    for (const [k, v] of finishes) this.finishes.set(k, v);
    for (const listener of [...this.listeners]) listener(next);
    return next;
  }

  subscribe(listener: (finish: SeenFinish) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

/** The body as text, or null past MAX_SEEN_BYTES: one announced over it is refused unread, one that lies about its length is cut off as it arrives. */
async function readSeenBody(request: Request): Promise<string | null> {
  const announced = Number(request.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > MAX_SEEN_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_SEEN_BYTES) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** /api/seen: GET every record, POST one. A watching device's POST is refused before this (index.ts). */
export async function handleSeenRequest(request: Request, store: SeenStore): Promise<Response> {
  const reply = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });
  if (request.method === "GET") return reply({ finishes: store.list() });
  if (request.method !== "POST") return reply({ error: { code: "method_not_allowed", message: "Use GET or POST /api/seen" } }, 405);
  const text = await readSeenBody(request);
  if (text === null) return reply({ error: { code: "too_large", message: "A read finish is at most 8 KB" } }, 413);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return badRequest("invalid_json", "The body is not JSON"); }
  const finish = seenFinishBody(raw);
  if (finish === null) return badRequest("invalid_body", "Send { pc, epoch, pane: string, id: positive integer, answer?: string }");
  try { return reply(store.record(finish)); }
  catch (error) { return reply({ error: { code: "seen_unwritable", message: error instanceof Error ? error.message : String(error) } }, 500); }
}
