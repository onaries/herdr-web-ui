import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { PreferenceStore } from "../../server/preferences.ts";
import { type PreferencesChange, type SharedPreferences } from "../../shared/preferences.ts";
import { DEFAULT_SETTINGS, SettingsProvider, sanitizeSettings, useSettings, type Settings } from "./settings.ts";
import { usePreferencesSync } from "./preferencesSync.ts";

const deadlineTimer = globalThis.setTimeout;
const clearDeadline = globalThis.clearTimeout;

// Keep React, the provider, the hook and its API functions real. Only the network and DOM
// boundaries are stand-ins: PUTs go through a real on-disk store, not a canned answer.
describe("preferences sync real send path", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let dir: string;
  let store: PreferenceStore;
  let records: Map<string, string>;
  let oldServer: boolean;
  let releaseAnswer: (() => Promise<void>) | undefined;
  let renderers: ReactTestRenderer[];
  let clients: Client[];
  let revisions: number[];
  let answers: number;
  let answerListeners: Set<() => void>;
  const dropNewKeys = (doc: SharedPreferences): SharedPreferences => ({
    ...doc, settings: Object.fromEntries(Object.entries(doc.settings).filter(([key]) => key !== "darkTheme" && key !== "lightTheme")),
  });
  interface Client {
    settings: Settings;
    rendered: { id: string; mode: string };
    update: (patch: Partial<Settings>) => void;
    receive: (doc: SharedPreferences) => void;
  }

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    records = new Map();
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      localStorage: { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => records.set(key, value) },
      setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
      clearTimeout: (id: number) => globalThis.clearTimeout(id),
      addEventListener() {}, removeEventListener() {},
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
    } });
    dir = mkdtempSync(join(tmpdir(), "herdr-sync-hook-"));
    store = new PreferenceStore(dir);
    oldServer = false;
    releaseAnswer = undefined;
    renderers = [];
    clients = [];
    revisions = [];
    answers = 0;
    answerListeners = new Set();
    store.subscribe((doc) => {
      revisions.push(doc.revision);
      for (const client of clients) client.receive(oldServer ? dropNewKeys(doc) : doc);
    });
    const fetchPreferences = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (init?.method !== "PUT") return Response.json(oldServer ? dropNewKeys(store.get()) : store.get());
      const body: PreferencesChange = JSON.parse(String(init.body));
      const settings = oldServer ? dropNewKeys({ revision: 0, settings: body.settings }).settings : body.settings;
      const saved = store.set({ ...body, settings });
      const answer = oldServer ? dropNewKeys(saved) : saved;
      if (releaseAnswer) await releaseAnswer();
      answers++;
      for (const listener of [...answerListeners]) listener();
      return Response.json(answer);
    };
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetchPreferences, { preconnect: globalThis.fetch.preconnect }));
    jest.useFakeTimers();
  });

  afterEach(async () => {
    await act(async () => { for (const renderer of renderers) renderer.unmount(); });
    jest.useRealTimers();
    jest.restoreAllMocks();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
    rmSync(dir, { recursive: true, force: true });
  });

  async function open(raw: object = DEFAULT_SETTINGS): Promise<Client> {
    records.clear();
    records.set("herdr-web-ui:settings", JSON.stringify(raw));
    const client: Client = { settings: sanitizeSettings(raw), rendered: { id: "amber", mode: "dark" }, update: () => { throw new Error("not mounted"); }, receive: () => { throw new Error("not mounted"); } };
    function Probe() {
      const context = useSettings();
      client.settings = context.settings;
      client.rendered = context.resolvedEntry;
      client.update = context.update;
      client.receive = usePreferencesSync(true);
      return null;
    }
    await act(async () => {
      renderers.push(create(createElement(SettingsProvider, null, createElement(Probe))));
    });
    clients.push(client);
    return client;
  }

  async function windows(count = 1): Promise<void> {
    for (let index = 0; index < count; index++) await act(async () => { jest.advanceTimersByTime(600); });
  }
  function nextAnswer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = deadlineTimer(() => { answerListeners.delete(done); reject(new Error("preferences answer did not arrive")); }, 2_000);
      const done = () => { clearDeadline(timer); answerListeners.delete(done); resolve(); };
      answerListeners.add(done);
    });
  }
  async function send(): Promise<void> {
    const answered = nextAnswer();
    await act(async () => { jest.advanceTimersByTime(600); await answered; });
  }
  const seed = { theme: "dark", palette: "tokyo-night", darkTheme: "tokyo-night", lightTheme: "tokyo-night-day" };

  it.each(["dark", "light"] as const)("takes a restarted legacy-only %s palette in a fresh client without corrective PUTs", async (theme) => {
    // Create valid old-format bytes without normalizing a new-format write, then restart.
    store.set({ settings: { palette: "catppuccin" } });
    store.set({ settings: { theme } });
    store = new PreferenceStore(dir);
    expect(store.get()).toEqual({ revision: 2, settings: { palette: "catppuccin", theme } });
    revisions.length = 0;
    store.subscribe((doc) => {
      revisions.push(doc.revision);
      for (const client of clients) client.receive(doc);
    });
    const client = await open({});
    expect(client.settings.palette).toBe("catppuccin");
    expect(client.settings[theme === "dark" ? "darkTheme" : "lightTheme"]).toBe("catppuccin");
    expect(client.rendered).toMatchObject({ id: "catppuccin", mode: theme });
    expect(document.documentElement.dataset["palette"]).toBe("catppuccin");
    await windows(3);
    expect(store.get().revision).toBe(2);
    expect(revisions).toEqual([]);
    expect(answers).toBe(0);
  });

  it("keeps a migrated device-local System pair on upgrade without a correcting PUT (h3)", async () => {
    store.set({ settings: { theme: "system", palette: "amber" } });
    const client = await open({ theme: "system", palette: "amber", paletteDark: "charcoal", paletteLight: "catppuccin" });
    await windows(3);
    expect(client.settings.darkTheme).toBe("charcoal");
    expect(client.settings.lightTheme).toBe("catppuccin");
    expect(revisions).toEqual([1]);
  });

  it("keeps a raw catppuccin-latte id stable across two new clients (h5)", async () => {
    store.set({ settings: { theme: "light", darkTheme: "tokyo-night", lightTheme: "catppuccin-latte" } });
    const a = await open();
    const b = await open();
    await windows(3);
    expect([a.settings.palette, b.settings.palette]).toEqual(["catppuccin-latte", "catppuccin-latte"]);
    expect(revisions).toEqual([1]);
    expect(answers).toBe(0);
  });

  it("takes one old palette write in three new clients without extra PUTs (h, h6)", async () => {
    store.set({ settings: seed });
    const group = [await open(), await open(), await open()];
    await act(async () => { store.set({ settings: { palette: "catppuccin" } }); });
    await windows(3);
    expect(group.map((client) => client.settings.darkTheme)).toEqual(["catppuccin", "catppuccin", "catppuccin"]);
    expect(group.map((client) => client.settings.palette)).toEqual(["catppuccin", "catppuccin", "catppuccin"]);
    expect(revisions).toEqual([1, 2]);
    expect(answers).toBe(0);
  });

  it.each(["charcoal", "amber"] as const)("persists an explicit old-tab %s choice arriving through a new server (f2, f3)", async (palette) => {
    store.set({ settings: seed });
    const client = await open(seed);
    await act(async () => { store.set({ settings: { palette } }); });
    await windows(3);
    expect(client.settings.darkTheme).toBe(palette);
    expect(JSON.parse(records.get("herdr-web-ui:themes") ?? "{}").darkTheme).toBe(palette);
    expect(revisions).toEqual([1, 2]);
  });

  it("sends a new dark choice once and another client takes it (i)", async () => {
    const a = await open();
    const b = await open();
    await act(async () => { a.update({ darkTheme: "tokyo-night" }); });
    await send();
    expect(answers).toBe(1);
    expect(b.settings.darkTheme).toBe("tokyo-night");
    await windows(3);
    expect(revisions).toEqual([1]);
  });

  it("acknowledges keys an old server dropped and resumes after upgrade without loops (j)", async () => {
    oldServer = true;
    const client = await open();
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await send();
    expect(answers).toBe(1);
    expect(client.settings.darkTheme).toBe("tokyo-night");
    expect(store.get().settings.palette).toBe("tokyo-night");
    await windows(3);
    expect(revisions).toEqual([1]);
    oldServer = false;
    await act(async () => { client.update({ darkTheme: "gruvbox" }); });
    await send();
    expect(store.get().settings.darkTheme).toBe("gruvbox");
    await windows(3);
    expect(revisions).toEqual([1, 2]);
  });

  it("acknowledges the sent dropped value without swallowing a later in-flight edit", async () => {
    oldServer = true;
    const gate = Promise.withResolvers<void>();
    releaseAnswer = () => gate.promise;
    const client = await open();
    await act(async () => { client.update({ darkTheme: "tokyo-night" }); });
    await windows();
    expect(revisions).toEqual([1]);
    await act(async () => { client.update({ darkTheme: "gruvbox" }); });
    const answered = nextAnswer();
    await act(async () => { gate.resolve(); await answered; });
    releaseAnswer = undefined;
    await send();
    expect(client.settings.darkTheme).toBe("gruvbox");
    expect(store.get().settings.palette).toBe("gruvbox");
    await windows(3);
    expect(revisions).toEqual([1, 2]);
  });
});
