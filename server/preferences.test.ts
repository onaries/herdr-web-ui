import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_PINS } from "../shared/preferences.ts";
import { handlePreferencesRequest, PreferenceStore } from "./preferences.ts";

const roots: string[] = [];
const root = (): string => { const dir = mkdtempSync(join(tmpdir(), "herdr-preferences-")); roots.push(dir); return dir; };
afterEach(() => {
  mock.restore();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const put = (store: PreferenceStore, body: string, headers: Record<string, string> = {}) => handlePreferencesRequest(new Request("http://x/api/preferences", { method: "PUT", body, headers }), store);

describe("shared preferences", () => {
  const seed = { theme: "dark", palette: "tokyo-night", darkTheme: "tokyo-night", lightTheme: "tokyo-night-day" };
  it.each([
    ["h", [{ palette: "catppuccin" }], { darkTheme: "catppuccin", lightTheme: "tokyo-night-day", palette: "catppuccin" }],
    ["h2", [{ theme: "light" }, { palette: "charcoal" }], { darkTheme: "tokyo-night", lightTheme: "charcoal", palette: "charcoal" }],
    ["h4", [{ theme: "light" }], { darkTheme: "tokyo-night", lightTheme: "tokyo-night-day", palette: "tokyo-night-day" }],
    ["h4b", [{ theme: "light" }, { palette: "charcoal" }], { darkTheme: "tokyo-night", lightTheme: "charcoal", palette: "charcoal" }],
    ["h4c", [{ theme: "system" }, { palette: "charcoal" }], { darkTheme: "tokyo-night", lightTheme: "tokyo-night-day", palette: "tokyo-night" }],
    ["new format takes precedence", [{ darkTheme: "gruvbox", palette: "charcoal" }], { darkTheme: "gruvbox", lightTheme: "tokyo-night-day", palette: "gruvbox" }],
    ["unknown ids stay on the server", [{ darkTheme: "future-theme" }], { darkTheme: "future-theme", lightTheme: "tokyo-night-day", palette: "future-theme" }],
  ] as const)("%s normalizes only at the store writer", (_label, changes, expected) => {
    const dir = root();
    const store = new PreferenceStore(dir);
    store.set({ settings: seed });
    const revisions: number[] = [];
    store.subscribe((doc) => revisions.push(doc.revision));
    for (const settings of changes) store.set({ settings });
    expect(store.get().settings).toMatchObject(expected);
    expect(revisions).toEqual(changes.map((_, index) => index + 2));
    expect(new PreferenceStore(dir).get()).toEqual(store.get());
  });

  it("does not invent a side for a legacy System or mode-only document", () => {
    const store = new PreferenceStore(root());
    store.set({ settings: { theme: "system", palette: "amber" } });
    expect(store.get().settings).toEqual({ theme: "system", palette: "amber" });
    store.set({ settings: { theme: "light" } });
    expect(store.get().settings).toEqual({ theme: "light", palette: "amber" });
  });

  it.each([
    ["dark", { lightTheme: "one-light" }, { theme: "dark", palette: "charcoal", darkTheme: "charcoal", lightTheme: "one-light" }],
    ["light", { darkTheme: "gruvbox" }, { theme: "light", palette: "charcoal", darkTheme: "gruvbox", lightTheme: "charcoal" }],
    ["system", { lightTheme: "one-light" }, { theme: "system", palette: "charcoal", darkTheme: "charcoal", lightTheme: "one-light" }],
  ] as const)("keeps a legacy %s document's palette on its side when a new client picks the other side", (theme, change, expected) => {
    // a document an older server wrote: one palette and no sides
    const dir = root();
    writeFileSync(join(dir, "preferences.json"), JSON.stringify({ revision: 3, settings: { theme, palette: "charcoal" } }));
    const store = new PreferenceStore(dir);
    store.set({ settings: change });
    expect(store.get().settings).toEqual(expected);
  });

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
    await put(store, JSON.stringify({ settings: { agentOrder: "activity" } }));
    expect(store.get()).toEqual({ revision: 3, settings: { showThinking: false, theme: "light", agentOrder: "activity" }, pins: ["local:w1:p1", "pc:w2:p3"] });
    await put(store, JSON.stringify({ settings: { theme: "dark" }, pins: [] }));
    expect(heard).toEqual([1, 2, 3, 4]);
    expect(JSON.parse(readFileSync(join(dir, "preferences.json"), "utf8"))).toMatchObject({ revision: 4, settings: { showThinking: false, theme: "dark", agentOrder: "activity" }, pins: [] });
    expect(new PreferenceStore(dir).get()).toEqual({ revision: 4, settings: { showThinking: false, theme: "dark", agentOrder: "activity" }, pins: [] });
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

});

describe("a damaged preferences file", () => {
  const file = (dir: string) => join(dir, "preferences.json");
  const bad = (dir: string) => `${file(dir)}.bad`;
  const files = (dir: string) => readdirSync(dir).sort();
  const quiet = () => spyOn(console, "error").mockImplementation(() => undefined);
  const expectPrivate = (path: string) => { if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600); };
  const get = async (store: PreferenceStore) => (await handlePreferencesRequest(new Request("http://x/api/preferences"), store)).json();

  it("preserves malformed bytes only on first effective write", async () => {
    const logged = quiet();
    const dir = root();
    const first = Buffer.from('{"revision": 7, "settings": {"theme": "dark"');
    writeFileSync(file(dir), first);
    const store = new PreferenceStore(dir);
    // reading changes nothing on disk
    expect(await get(store)).toEqual({ revision: 0, settings: {} });
    expect(readFileSync(file(dir))).toEqual(first);
    expect(files(dir)).toEqual(["preferences.json"]);
    expect(logged.mock.calls.flat().join("\n")).toContain("not JSON");
    expect(logged.mock.calls.flat().join("\n")).not.toContain('"theme"');
    // the file changed to other damaged bytes since the start: those are the ones kept
    const current = Buffer.from("{still not json");
    writeFileSync(file(dir), current);
    expect((await put(store, JSON.stringify({ settings: { theme: "light" } }))).status).toBe(200);
    expect(readFileSync(bad(dir))).toEqual(current);
    expectPrivate(bad(dir));
    expect(new PreferenceStore(dir).get()).toEqual({ revision: 1, settings: { theme: "light" } });
    store.set({ settings: { agentOrder: "activity" } });
    expect(readFileSync(bad(dir))).toEqual(current);
    expect(files(dir)).toEqual(["preferences.json", "preferences.json.bad"]);
    // damaged again: one generation, the latest
    const again = Buffer.from("\u0000\u0001 not json either");
    writeFileSync(file(dir), again);
    new PreferenceStore(dir).set({ settings: { theme: "dark" } });
    expect(readFileSync(bad(dir))).toEqual(again);
    expect(files(dir)).toEqual(["preferences.json", "preferences.json.bad"]);
  });

  it.each([
    ["settings as a list", '{"revision":2,"settings":[],"pins":[]}'],
    ["a pin that is not a string", '{"revision":2,"settings":{"theme":"dark"},"pins":[1]}'],
    ["a list", "[]"],
    ["a string", '"preferences"'],
  ])("preserves wrong-shaped documents privately: %s", (_label, text) => {
    const logged = quiet();
    const dir = root();
    const bytes = Buffer.from(text);
    writeFileSync(file(dir), bytes, { mode: 0o644 });
    const store = new PreferenceStore(dir);
    expect(store.get()).toEqual({ revision: 0, settings: {} });
    expect(readFileSync(file(dir))).toEqual(bytes);
    expect(files(dir)).toEqual(["preferences.json"]);
    expect(logged.mock.calls.flat().join("\n")).toContain("not a preferences document");
    store.set({ settings: { theme: "light" } });
    expect(readFileSync(bad(dir))).toEqual(bytes);
    expectPrivate(bad(dir));
    expect(files(dir)).toEqual(["preferences.json", "preferences.json.bad"]);
    expect(new PreferenceStore(dir).get()).toEqual({ revision: 1, settings: { theme: "light" } });
  });

  it("keeps a manual repair rather than quarantining it", () => {
    quiet();
    const dir = root();
    writeFileSync(file(dir), "not json");
    const store = new PreferenceStore(dir);
    const heard: unknown[] = [];
    store.subscribe((preferences) => heard.push(preferences));
    // repaired by hand while the server runs
    writeFileSync(file(dir), JSON.stringify({ revision: 5, settings: { theme: "dark", agentOrder: "activity" }, pins: ["pc:w1:p1"] }));
    const expected = { revision: 6, settings: { theme: "light", agentOrder: "activity" }, pins: ["pc:w1:p1"] };
    expect(store.set({ settings: { theme: "light" } })).toEqual(expected);
    expect(heard).toEqual([expected]);
    expect(files(dir)).toEqual(["preferences.json"]);
    expect(new PreferenceStore(dir).get()).toEqual(expected);
  });

  it("refuses to write over a file it cannot read", async () => {
    quiet();
    const dir = root();
    // a directory where the file should be: reading it fails, and it is not an absent file
    mkdirSync(file(dir));
    writeFileSync(join(file(dir), "keep"), "kept");
    const store = new PreferenceStore(dir);
    const heard: number[] = [];
    store.subscribe((preferences) => heard.push(preferences.revision));
    const failed = await put(store, JSON.stringify({ settings: { theme: "light" } }));
    expect(failed.status).toBe(500);
    expect(((await failed.json()) as { error: { code: string } }).error.code).toBe("preferences_unwritable");
    expect(readFileSync(join(file(dir), "keep"), "utf8")).toBe("kept");
    expect(files(dir)).toEqual(["preferences.json"]);
    expect(heard).toEqual([]);
  });

  it("refuses overwrite when preservation fails", async () => {
    quiet();
    const dir = root();
    const bytes = Buffer.from('{"settings": [1, 2, 3]}');
    writeFileSync(file(dir), bytes);
    // the older generation cannot be replaced: a directory with something in it
    mkdirSync(bad(dir));
    writeFileSync(join(bad(dir), "older"), "older");
    const store = new PreferenceStore(dir);
    const heard: number[] = [];
    store.subscribe((preferences) => heard.push(preferences.revision));
    const failed = await put(store, JSON.stringify({ settings: { theme: "light" } }));
    expect(failed.status).toBe(500);
    const { error } = (await failed.json()) as { error: { code: string; message: string } };
    expect(error.code).toBe("preferences_unwritable");
    expect(error.message).toContain("preferences.json.bad");
    expect(readFileSync(file(dir))).toEqual(bytes);
    expect(readFileSync(join(bad(dir), "older"), "utf8")).toBe("older");
    expect(files(dir)).toEqual(["preferences.json", "preferences.json.bad"]);
    expect(store.get()).toEqual({ revision: 0, settings: {} });
    expect(heard).toEqual([]);
    // once it can be kept, the same change goes through
    rmSync(bad(dir), { recursive: true });
    expect((await put(store, JSON.stringify({ settings: { theme: "light" } }))).status).toBe(200);
    expect(readFileSync(bad(dir))).toEqual(bytes);
    expect(heard).toEqual([1]);
  });

  it("retains one bad generation across replacement failure", async () => {
    quiet();
    const dir = root();
    const bytes = Buffer.from("{damaged");
    writeFileSync(file(dir), bytes);
    writeFileSync(bad(dir), "an older damaged generation");
    const store = new PreferenceStore(dir);
    const heard: number[] = [];
    store.subscribe((preferences) => heard.push(preferences.revision));
    const rename = fs.renameSync;
    const spy = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from).endsWith(".tmp")) throw Object.assign(new Error("EIO: i/o error, rename"), { code: "EIO" });
      rename(from, to);
    });
    expect((await put(store, JSON.stringify({ settings: { theme: "light" } }))).status).toBe(500);
    spy.mockRestore();
    expect(readFileSync(bad(dir))).toEqual(bytes);
    expect(files(dir).filter((name) => name.endsWith(".bad"))).toEqual(["preferences.json.bad"]);
    expect(store.get()).toEqual({ revision: 0, settings: {} });
    expect(heard).toEqual([]);
    // the retry finds no file to keep aside and leaves the recovery bytes where they are
    expect((await put(store, JSON.stringify({ settings: { theme: "light" } }))).status).toBe(200);
    expect(readFileSync(bad(dir))).toEqual(bytes);
    expect(files(dir)).toEqual(["preferences.json", "preferences.json.bad"]);
    expect(heard).toEqual([1]);
    expect(new PreferenceStore(dir).get()).toEqual({ revision: 1, settings: { theme: "light" } });
  });

  it("preserves a file damaged after a valid start on the first write", () => {
    quiet();
    const dir = root();
    writeFileSync(file(dir), JSON.stringify({ revision: 3, settings: { theme: "dark" } }));
    const store = new PreferenceStore(dir);
    expect(store.get()).toEqual({ revision: 3, settings: { theme: "dark" } });
    const bytes = Buffer.from("{damaged after the start");
    writeFileSync(file(dir), bytes);
    store.set({ settings: { theme: "light" } });
    expect(readFileSync(bad(dir))).toEqual(bytes);
    expectPrivate(bad(dir));
    expect(files(dir)).toEqual(["preferences.json", "preferences.json.bad"]);
    expect(new PreferenceStore(dir).get()).toEqual({ revision: 4, settings: { theme: "light" } });
  });
});
