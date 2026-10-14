import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_PINS } from "../shared/preferences.ts";
import { handlePreferencesRequest, PreferenceStore } from "./preferences.ts";

const roots: string[] = [];
const root = (): string => { const dir = mkdtempSync(join(tmpdir(), "herdr-preferences-")); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const put = (store: PreferenceStore, body: string, headers: Record<string, string> = {}) => handlePreferencesRequest(new Request("http://x/api/preferences", { method: "PUT", body, headers }), store);

describe("shared preferences", () => {
  it("starts empty, keeps only the shared names, counts each write, and survives a restart", async () => {
    const dir = root();
    const store = new PreferenceStore(dir);
    // no pins until a browser shares its own: an empty list would be taken for everyone's
    expect(await (await handlePreferencesRequest(new Request("http://x/api/preferences"), store)).json()).toEqual({ revision: 0, settings: {} });
    const heard: number[] = [];
    store.subscribe((preferences) => heard.push(preferences.revision));
    const settingsOnly = await put(store, JSON.stringify({ settings: { showThinking: false } }));
    expect(await settingsOnly.json()).toEqual({ revision: 1, settings: { showThinking: false } });
    const first = await put(store, JSON.stringify({ settings: { theme: "light", terminalFontSize: 22, alertsOn: false, nonsense: 1 }, pins: ["local:w1:p1", "local:w1:p1", "pc:w2:p3"] }));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ revision: 2, settings: { showThinking: false, theme: "light" }, pins: ["local:w1:p1", "pc:w2:p3"] });
    // a change lays its settings over what is held, and leaves the pins when it names none
    await put(store, JSON.stringify({ settings: { agentPins: true } }));
    expect(store.get()).toEqual({ revision: 3, settings: { showThinking: false, theme: "light", agentPins: true }, pins: ["local:w1:p1", "pc:w2:p3"] });
    await put(store, JSON.stringify({ settings: { theme: "dark" }, pins: [] }));
    expect(heard).toEqual([1, 2, 3, 4]);
    expect(JSON.parse(readFileSync(join(dir, "preferences.json"), "utf8"))).toMatchObject({ revision: 4, settings: { showThinking: false, theme: "dark", agentPins: true }, pins: [] });
    expect(new PreferenceStore(dir).get()).toEqual({ revision: 4, settings: { showThinking: false, theme: "dark", agentPins: true }, pins: [] });
  });

  it("refuses what is not a preferences document", async () => {
    const store = new PreferenceStore(root());
    expect((await put(store, "{")).status).toBe(400);
    expect((await put(store, JSON.stringify({ settings: [], pins: [] }))).status).toBe(400);
    expect((await put(store, JSON.stringify({ settings: {}, pins: [1] }))).status).toBe(400);
    expect((await put(store, JSON.stringify({ settings: {}, pins: Array.from({ length: MAX_PINS + 1 }, (_, i) => `pc:${i}`) }))).status).toBe(400);
    expect((await put(store, JSON.stringify({ settings: { quickReplies: ["x".repeat(70_000)] }, pins: [] }))).status).toBe(413);
    // a body that says it is too large is refused unread
    expect((await put(store, "{}", { "content-length": String(70_000) })).status).toBe(413);
    expect((await handlePreferencesRequest(new Request("http://x/api/preferences", { method: "POST", body: "{}" }), store)).status).toBe(405);
    expect(store.get().revision).toBe(0);
  });

  it("keeps the whole document under the limit, not only each change", async () => {
    const store = new PreferenceStore(root());
    expect((await put(store, JSON.stringify({ settings: { quickReplies: ["x".repeat(40_000)] } }))).status).toBe(200);
    const over = await put(store, JSON.stringify({ settings: { usageOrder: ["y".repeat(40_000)] } }));
    expect(over.status).toBe(413);
    expect(store.get()).toMatchObject({ revision: 1 });
    expect(store.get().settings["usageOrder"]).toBeUndefined();
  });

  it("holds and tells a change only once it is on disk", async () => {
    const dir = root();
    const file = join(dir, "state");
    writeFileSync(file, "a file where the state directory should be");
    const store = new PreferenceStore(file);
    const heard: number[] = [];
    store.subscribe((preferences) => heard.push(preferences.revision));
    const failed = await put(store, JSON.stringify({ settings: { theme: "light" } }));
    expect(failed.status).toBe(500);
    expect(await (await handlePreferencesRequest(new Request("http://x/api/preferences"), store)).json()).toEqual({ revision: 0, settings: {} });
    expect(heard).toEqual([]);
  });

  it("starts empty over a damaged file", () => {
    const dir = root();
    writeFileSync(join(dir, "preferences.json"), "not json");
    expect(new PreferenceStore(dir).get()).toEqual({ revision: 0, settings: {} });
  });
});
