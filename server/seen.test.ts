import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineEvent } from "../shared/machines.ts";
import { MAX_SEEN, type SeenFinish } from "../shared/seen.ts";
import { handleMachineRequest } from "./machine-api.ts";
import type { MachineManager } from "./machines.ts";
import { handleSeenRequest, SeenStore } from "./seen.ts";

const roots: string[] = [];
const root = (): string => { const dir = mkdtempSync(join(tmpdir(), "herdr-seen-")); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const post = (store: SeenStore, body: string) => handleSeenRequest(new Request("http://x/api/seen", { method: "POST", body }), store);
const finish = (pane: string, id: number, answer?: string): SeenFinish => ({ pc: "local", epoch: "e1", pane, id, ...(answer === undefined ? {} : { answer }) });

describe("read finishes shared by the browsers of a server", () => {
  it("keeps the greatest finish per pane, adds a missing answer, and tells only a change", () => {
    const dir = root();
    const store = new SeenStore(dir);
    const told: SeenFinish[] = [];
    store.subscribe((changed) => told.push(changed));
    store.record(finish("a", 2));
    store.record(finish("a", 1, "older"));
    store.record(finish("a", 2));
    store.record(finish("a", 2, "answer"));
    store.record(finish("a", 2, "another"));
    store.record({ ...finish("a", 1), epoch: "e2" });
    expect(told).toEqual([finish("a", 2), finish("a", 2, "answer"), { ...finish("a", 1), epoch: "e2" }]);
    expect(store.list()).toEqual([finish("a", 2, "answer"), { ...finish("a", 1), epoch: "e2" }]);
    expect(new SeenStore(dir).list()).toEqual(store.list());
  });

  it("drops the oldest records past the limit", () => {
    const store = new SeenStore(root());
    for (let pane = 0; pane <= MAX_SEEN; pane++) store.record(finish(`p${pane}`, 1));
    store.record(finish("p1", 2));
    const panes = store.list().map((kept) => kept.pane);
    expect(panes).toHaveLength(MAX_SEEN);
    expect(panes).not.toContain("p0");
    expect(panes.at(-1)).toBe("p1");
  });

  it("starts empty from a damaged file and replaces it on the next write", () => {
    const dir = root();
    writeFileSync(join(dir, "seen.json"), "{not json");
    const store = new SeenStore(dir);
    expect(store.list()).toEqual([]);
    store.record(finish("a", 1));
    expect(JSON.parse(readFileSync(join(dir, "seen.json"), "utf8"))).toEqual([finish("a", 1)]);
  });

  it("answers GET and POST, and refuses what is not a read finish", async () => {
    const store = new SeenStore(root());
    const answered = await post(store, JSON.stringify(finish("a", 3)));
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual(finish("a", 3));
    expect(await (await post(store, JSON.stringify(finish("a", 1)))).json()).toEqual(finish("a", 3));
    expect(await (await handleSeenRequest(new Request("http://x/api/seen"), store)).json()).toEqual({ finishes: [finish("a", 3)] });
    for (const body of ["nope", "[]", JSON.stringify({ ...finish("a", 1), id: 0 }), JSON.stringify({ ...finish("a", 1), id: 1.5 }),
      JSON.stringify({ ...finish("a", 1), pane: "" }), JSON.stringify({ ...finish("a", 1), answer: 7 }), JSON.stringify({ ...finish("a", 1), answer: "x".repeat(2049) })]) {
      expect([body.slice(0, 40), (await post(store, body)).status]).toEqual([body.slice(0, 40), 400]);
    }
    expect((await post(store, "x".repeat(9000))).status).toBe(413);
    expect((await handleSeenRequest(new Request("http://x/api/seen", { method: "PUT", body: "{}" }), store)).status).toBe(405);
  });

  it("stops reading a body as soon as it passes 8 KB", async () => {
    const store = new SeenStore(root());
    let pulled = 0;
    const twoMiB = new ReadableStream<Uint8Array>({
      pull(controller) { if (++pulled > 512) controller.close(); else controller.enqueue(new Uint8Array(4096)); },
    });
    const response = await handleSeenRequest(new Request("http://x/api/seen", { method: "POST", body: twoMiB, duplex: "half" } as RequestInit), store);
    expect(response.status).toBe(413);
    expect(pulled).toBeLessThan(10);
    expect(store.list()).toEqual([]);
  });

  it("sends every record when a browser connects to the machine events, then each change", async () => {
    const store = new SeenStore(root());
    store.record(finish("a", 1));
    const manager = { subscribe: () => () => undefined } as unknown as MachineManager;
    const abort = new AbortController();
    const response = await handleMachineRequest(new Request("http://127.0.0.1:7317/api/machines/events", { signal: abort.signal }), manager,
      undefined, undefined, false, undefined, store);
    const reader = response.body!.getReader();
    const events: MachineEvent[] = [];
    let buffer = "";
    const read = async (): Promise<void> => {
      const { value } = await reader.read();
      buffer += new TextDecoder().decode(value);
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)) as MachineEvent);
      }
    };
    try {
      while (events.length === 0) await read();
      expect(events).toEqual([{ type: "seen", finishes: [finish("a", 1)] }]);
      store.record(finish("b", 4));
      while (events.length === 1) await read();
      expect(events[1]).toEqual({ type: "seen", finishes: [finish("b", 4)] });
    } finally {
      abort.abort();
      await reader.cancel().catch(() => undefined);
    }
  });
});
