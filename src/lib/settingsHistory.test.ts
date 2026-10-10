import { afterAll, afterEach, describe, expect, it } from "bun:test";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

/** A browser's history, as far as this module uses it: a stack, a cursor, and popstate after `go`. */
function fakeWindow() {
  const stack: unknown[] = [null];
  let index = 0;
  const listeners: Array<(event: { state: unknown }) => void> = [];
  const history = {
    get state() { return stack[index]; },
    pushState(state: unknown) { stack.splice(index + 1); stack.push(state); index += 1; },
    replaceState(state: unknown) { stack[index] = state; },
    go(by: number) { index = Math.max(0, Math.min(stack.length - 1, index + by)); queueMicrotask(() => { for (const listener of listeners) listener({ state: stack[index] }); }); },
  };
  const window = { history, addEventListener(type: string, listener: (event: { state: unknown }) => void) { if (type === "popstate") listeners.push(listener); } };
  /** the Settings entries up to the current one, as the module wrote them */
  const held = () => stack.slice(0, index + 1).map((state) => (state as Record<string, unknown> | null)?.["herdr-web-ui:settings"] ?? null);
  return { window, held };
}
const fake = fakeWindow();
(globalThis as unknown as { window: unknown }).window = fake.window;
// after the window: the module listens to it as it loads
const { recordSettings, settingsEntry, settingsLevels } = await import("./settingsHistory.ts");
const settled = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => queueMicrotask(() => resolve(undefined))); };

describe("settingsLevels", () => {
  it("makes a phone's list a step of its own, under the page and the key bar editor", () => {
    expect(settingsLevels(true, null, false)).toEqual([{ page: null, keyBar: false }]);
    expect(settingsLevels(true, "chat", false)).toEqual([{ page: null, keyBar: false }, { page: "chat", keyBar: false }]);
    expect(settingsLevels(true, "terminal", true)).toEqual([{ page: null, keyBar: false }, { page: "terminal", keyBar: false }, { page: "terminal", keyBar: true }]);
  });

  it("opens a wider dialog on its page: one step, and the key bar editor a second", () => {
    expect(settingsLevels(false, "appearance", false)).toEqual([{ page: "appearance", keyBar: false }]);
    expect(settingsLevels(false, "terminal", true)).toEqual([{ page: "terminal", keyBar: false }, { page: "terminal", keyBar: true }]);
  });

  it("has no key bar step without a page under it", () => {
    expect(settingsLevels(true, null, true)).toEqual([{ page: null, keyBar: false }]);
  });
});

describe("settingsEntry", () => {
  const state = (entry: unknown) => ({ "herdr-web-ui:settings": entry });

  it("reads the entry beside whatever else the state holds", () => {
    expect(settingsEntry({ ...state({ page: "chat", keyBar: false, depth: 2 }), "herdr-web-ui:file-preview": { path: "a" } })).toEqual({ page: "chat", keyBar: false, depth: 2 });
    expect(settingsEntry(state({ page: null, keyBar: false, depth: 1 }))).toEqual({ page: null, keyBar: false, depth: 1 });
  });

  it("is null for a state without one, or one it did not write", () => {
    for (const other of [null, undefined, "settings", 1, {}, state(null), state("chat"), state({ page: 3, keyBar: false, depth: 1 }), state({ page: "chat", keyBar: "no", depth: 1 }),
      state({ page: "chat", keyBar: false }), state({ page: "chat", keyBar: false, depth: 0 }), state({ page: "chat", keyBar: false, depth: 1.5 }), state({ page: "chat", keyBar: false, depth: 9 })]) {
      expect(settingsEntry(other)).toBeNull();
    }
  });
});

describe("recordSettings", () => {
  it("rebuilds the earlier steps when the width changes: the list goes under a page a wider dialog opened, and away again", async () => {
    // a wider dialog opened on Terminal: one step
    recordSettings([{ page: "terminal", keyBar: false }]);
    await settled();
    expect(fake.held()).toEqual([null, { page: "terminal", keyBar: false, depth: 1 }]);
    // the window narrows: a phone's list belongs under the page, not a second Terminal over it
    recordSettings([{ page: null, keyBar: false }, { page: "terminal", keyBar: false }]);
    await settled();
    expect(fake.held()).toEqual([null, { page: null, keyBar: false, depth: 1 }, { page: "terminal", keyBar: false, depth: 2 }]);
    // the key bar editor opens on the phone, then the window widens: the list under them goes
    recordSettings([{ page: null, keyBar: false }, { page: "terminal", keyBar: false }, { page: "terminal", keyBar: true }]);
    await settled();
    recordSettings([{ page: "terminal", keyBar: false }, { page: "terminal", keyBar: true }]);
    await settled();
    expect(fake.held()).toEqual([null, { page: "terminal", keyBar: false, depth: 1 }, { page: "terminal", keyBar: true, depth: 2 }]);
    // closing takes every step off
    recordSettings([]);
    await settled();
    expect(fake.held()).toEqual([null]);
  });

  it("does not take a step it cannot see on trust: entries of an earlier opening a Forward landed on are rebuilt", async () => {
    // entries an earlier opening left (a wider dialog's Terminal and its editor), landed on by Forward
    const key = "herdr-web-ui:settings";
    fake.window.history.pushState({ [key]: { page: "terminal", keyBar: false, depth: 1 } });
    fake.window.history.pushState({ [key]: { page: "terminal", keyBar: true, depth: 2 } });
    // the dialog opens on a phone showing the editor: the list, the page, the editor
    recordSettings([{ page: null, keyBar: false }, { page: "terminal", keyBar: false }, { page: "terminal", keyBar: true }]);
    await settled();
    expect(fake.held()).toEqual([null, { page: null, keyBar: false, depth: 1 }, { page: "terminal", keyBar: false, depth: 2 }, { page: "terminal", keyBar: true, depth: 3 }]);
    recordSettings([]);
    await settled();
    expect(fake.held()).toEqual([null]);
  });
});

// Slow traversals need a cursor that moves only when they land, and a clock under the test's
// control. Restore globals so this import-time browser stub cannot leak into another file.
const baselineWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
afterEach(() => {
  if (baselineWindow) Object.defineProperty(globalThis, "window", baselineWindow);
  else Reflect.deleteProperty(globalThis, "window");
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
});
afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

let loadId = 0;
async function delayedHistory(initial: unknown[] = [null]) {
  const stack = [...initial];
  let index = stack.length - 1;
  let now = 0;
  let timerId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const listeners: Array<(event: { state: unknown }) => void> = [];
  const requests: number[] = [];
  const history = {
    get state() { return stack[index]; },
    pushState(state: unknown) { stack.splice(index + 1); stack.push(state); index++; },
    replaceState(state: unknown) { stack[index] = state; },
    go(by: number) { requests.push(index + by); },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: {
    history,
    addEventListener(type: string, listener: (event: { state: unknown }) => void) {
      if (type === "popstate") listeners.push(listener);
    },
  } });
  Object.defineProperty(globalThis, "setTimeout", { configurable: true, writable: true, value: (run: () => void, ms: number) => {
    timers.set(++timerId, { at: now + ms, run });
    return timerId;
  } });
  Object.defineProperty(globalThis, "clearTimeout", { configurable: true, writable: true, value: (id: number) => timers.delete(id) });
  const module: typeof import("./settingsHistory.ts") = await import(`./settingsHistory.ts?delayed=${++loadId}`);
  const dispatch = async () => {
    await new Promise<void>((resolve) => queueMicrotask(() => {
      for (const listener of listeners) listener({ state: history.state });
      resolve();
    }));
  };
  return {
    ...module, history, requests,
    get index() { return index; },
    async land() {
      const target = requests.shift();
      if (target === undefined) throw new Error("no requested traversal to land");
      if (target >= 0 && target < stack.length && target !== index) { index = target; await dispatch(); }
    },
    async move(by: number) { index += by; await dispatch(); },
    dispatch,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].run();
      }
      now = end;
    },
  };
}

describe("history traversal races", () => {
  it("keeps a late width-change traversal its own after the landing deadline", async () => {
    const browser = await delayedHistory();
    browser.recordSettings(browser.settingsLevels(true, "terminal", true));
    const moves: boolean[] = [];
    browser.onSettingsHistory((_entry, own) => moves.push(own));
    browser.recordSettings(browser.settingsLevels(false, "terminal", true));
    browser.advance(500);
    browser.recordSettings(browser.settingsLevels(true, "terminal", true));
    browser.advance(501);
    await browser.land();
    expect(moves).toEqual([true]);
    expect(browser.settingsEntry(browser.history.state)).toEqual({ page: "terminal", keyBar: true, depth: 3 });
  });

  it("does not retry a traversal every second when no landing arrives", async () => {
    const browser = await delayedHistory();
    browser.recordSettings(browser.settingsLevels(true, "terminal", true));
    browser.recordSettings([]);
    browser.advance(10_000);
    expect(browser.requests).toHaveLength(1);
  });

  it("waits for the same pending destination across updates after the deadline", async () => {
    const browser = await delayedHistory();
    browser.recordSettings(browser.settingsLevels(true, "terminal", true));
    browser.recordSettings(browser.settingsLevels(false, "terminal", true));
    browser.advance(1001);
    browser.recordSettings(browser.settingsLevels(true, "terminal", true));
    expect(browser.requests).toHaveLength(1);
    await browser.land();
    expect(browser.settingsEntry(browser.history.state)).toEqual({ page: "terminal", keyBar: true, depth: 3 });
  });

  it("reconciles the latest levels after a delayed traversal lands", async () => {
    const browser = await delayedHistory();
    browser.recordSettings(browser.settingsLevels(true, "terminal", true));
    browser.recordSettings(browser.settingsLevels(false, "terminal", true));
    browser.advance(1001);
    browser.recordSettings(browser.settingsLevels(false, "appearance", false));
    expect(browser.requests).toHaveLength(1);
    await browser.land();
    expect(browser.requests).toHaveLength(1);
    await browser.land();
    expect(browser.settingsEntry(browser.history.state)).toEqual({ page: "appearance", keyBar: false, depth: 1 });
    expect(browser.requests).toEqual([]);
  });

  it("completes an unmount reset after a pending width traversal lands late", async () => {
    const browser = await delayedHistory();
    browser.recordSettings(browser.settingsLevels(true, "terminal", true));
    const moves: boolean[] = [];
    browser.onSettingsHistory((_entry, own) => moves.push(own));
    browser.recordSettings(browser.settingsLevels(false, "terminal", true));
    browser.advance(1001);
    // SettingsDialog unmounts before its width-change traversal has landed.
    browser.recordSettings([]);
    expect(browser.requests).toHaveLength(1);
    await browser.land();
    expect(moves).toEqual([true]);
    expect(browser.requests).toHaveLength(1);
    await browser.land();
    expect(browser.settingsEntry(browser.history.state)).toBeNull();
    expect(browser.requests).toEqual([]);
  });

  it("does not notify an unsubscribed listener when a traversal lands", async () => {
    const browser = await delayedHistory();
    browser.recordSettings(browser.settingsLevels(true, "terminal", true));
    const moves: boolean[] = [];
    const unsubscribe = browser.onSettingsHistory((_entry, own) => moves.push(own));
    browser.recordSettings(browser.settingsLevels(false, "terminal", true));
    unsubscribe();
    await browser.land();
    expect(moves).toEqual([]);
  });

  it("characterizes markerless landing leaving the old Settings depth reachable by Back", async () => {
    const browser = await delayedHistory();
    browser.recordSettings(browser.settingsLevels(true, "terminal", true));
    const moves: Array<[ReturnType<typeof browser.settingsEntry>, boolean]> = [];
    browser.onSettingsHistory((entry, own) => moves.push([entry, own]));
    browser.history.pushState({ route: "markerless" });
    browser.history.pushState({ route: "after-markerless" });

    // Back lands on a state without our marker. Closing cannot tell that older Settings entries
    // are still in history, so it does not rewind them; another Back restores their old depth.
    await browser.move(-1);
    expect(moves).toEqual([[null, false]]);
    browser.recordSettings([]);
    expect(browser.requests).toEqual([]);
    await browser.move(-1);
    expect(moves[1]).toEqual([{ page: "terminal", keyBar: true, depth: 3 }, false]);
  });

  it("records a deeper reopening after an unanswered close traversal", async () => {
    const browser = await delayedHistory();
    browser.recordSettings(browser.settingsLevels(true, null, false));
    browser.recordSettings([]);
    browser.advance(1001);
    browser.recordSettings(browser.settingsLevels(true, "terminal", false));
    expect(browser.settingsEntry(browser.history.state)).toEqual({ page: "terminal", keyBar: false, depth: 2 });
    expect(browser.requests).toHaveLength(1);
  });

  it("does not replace an unanswered traversal with another rewind", async () => {
    const browser = await delayedHistory();
    browser.recordSettings(browser.settingsLevels(true, "terminal", true));
    browser.recordSettings([]);
    browser.advance(1001);
    browser.recordSettings(browser.settingsLevels(false, "appearance", false));
    expect(browser.requests).toHaveLength(1);
  });

  it("does not consume Back after a timed-out close and reopening", async () => {
    const browser = await delayedHistory();
    browser.recordSettings(browser.settingsLevels(true, null, false));
    const moves: boolean[] = [];
    browser.onSettingsHistory((_entry, own) => moves.push(own));
    browser.recordSettings([]);
    browser.advance(1001);
    browser.recordSettings(browser.settingsLevels(true, null, false));
    await browser.move(-1);
    expect(moves).toEqual([false]);
    expect(browser.settingsEntry(browser.history.state)).toBeNull();
  });

  it("does not consume Back when reopening precedes the timeout", async () => {
    const browser = await delayedHistory();
    browser.recordSettings(browser.settingsLevels(true, null, false));
    const moves: boolean[] = [];
    browser.onSettingsHistory((_entry, own) => moves.push(own));
    browser.recordSettings([]);
    browser.advance(500);
    browser.recordSettings(browser.settingsLevels(true, null, false));
    browser.advance(501);
    await browser.move(-1);
    expect(moves).toEqual([false]);
    expect(browser.settingsEntry(browser.history.state)).toBeNull();
  });

  it("steps out of reload entries even when the traversal lands late", async () => {
    const browser = await delayedHistory([null,
      { "herdr-web-ui:settings": { page: "terminal", keyBar: false, depth: 1 } },
      { "herdr-web-ui:settings": { page: "terminal", keyBar: true, depth: 2 } },
    ]);
    const moves: boolean[] = [];
    browser.onSettingsHistory((_entry, own) => moves.push(own));
    browser.advance(1001);
    await browser.land();
    expect(moves).toEqual([true]);
    expect(browser.index).toBe(0);
    expect(browser.requests).toEqual([]);
  });

  it("expires pending ownership when an unrelated landing wins", async () => {
    const browser = await delayedHistory();
    browser.recordSettings(browser.settingsLevels(true, "terminal", true));
    const moves: boolean[] = [];
    browser.onSettingsHistory((_entry, own) => moves.push(own));
    browser.recordSettings(browser.settingsLevels(false, "terminal", true));
    await browser.move(-2); // depth 1 is not the requested depth 2
    await browser.land();
    expect(moves).toEqual([false, false]);
  });

  for (const method of ["pushState", "replaceState"] as const) {
    it(`releases pending ownership after foreign ${method}`, async () => {
      const browser = await delayedHistory();
      browser.recordSettings(browser.settingsLevels(true, null, false));
      browser.recordSettings([]);
      browser.advance(1001);
      browser.history[method]({ route: "other" });
      browser.recordSettings(browser.settingsLevels(true, null, false));
      expect(browser.settingsEntry(browser.history.state)).toEqual({ page: null, keyBar: false, depth: 1 });
      const beforeClose = browser.requests.length;
      browser.recordSettings([]);
      expect(browser.requests).toHaveLength(beforeClose + 1);
    });

    it(`does not claim Back after silent foreign ${method}`, async () => {
      const browser = await delayedHistory();
      browser.recordSettings(browser.settingsLevels(true, "terminal", true));
      const moves: boolean[] = [];
      browser.onSettingsHistory((_entry, own) => moves.push(own));
      browser.recordSettings(browser.settingsLevels(false, "terminal", true));
      browser.recordSettings(browser.settingsLevels(true, "terminal", true));
      browser.advance(1001);
      browser.history[method]({ route: "other" });
      await browser.move(method === "pushState" ? -2 : -1);
      expect(moves).toEqual([false]);
    });
  }
});
