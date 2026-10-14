import { afterAll, describe, expect, it } from "bun:test";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

/** A browser's history as the module uses it: entries with a state and an address, a cursor, popstate after a traversal. */
function fakeWindow() {
  const entries: Array<{ state: unknown; href: string }> = [{ state: null, href: "/?pane=a" }];
  let index = 0;
  const listeners: Array<(event: { state: unknown }) => void> = [];
  /** a browser runs a traversal later, toward the entry it named when called: a test turns this on to open something meanwhile */
  let deferred = false;
  let pending = false;
  const traverse = (by: number): void => {
    const next = Math.max(0, Math.min(entries.length - 1, index + by));
    if (next === index) return;
    const land = (): void => {
      index = Math.min(next, entries.length - 1);
      for (const listener of listeners) listener({ state: entries[index]!.state });
    };
    if (!deferred) { index = next; queueMicrotask(() => { for (const listener of listeners) listener({ state: entries[index]!.state }); }); return; }
    pending = true;
    setTimeout(() => { pending = false; land(); }, 1);
  };
  const history = {
    get state() { return entries[index]!.state; },
    pushState(state: unknown, _title: string, url?: string | null) { entries.splice(index + 1); entries.push({ state, href: url ?? entries[index]!.href }); index += 1; },
    replaceState(state: unknown, _title: string, url?: string | null) { entries[index] = { state, href: url ?? entries[index]!.href }; },
    back() { traverse(-1); },
    forward() { traverse(1); },
    go(by: number) { traverse(by); },
  };
  const window = {
    history,
    get location() { return { href: entries[index]!.href }; },
    addEventListener(type: string, listener: (event: { state: unknown }) => void) { if (type === "popstate") listeners.push(listener); },
  };
  return { window, entries, at: () => index, defer: (on: boolean) => { deferred = on; }, pending: () => pending, marks: () => entries.map((entry) => typeof (entry.state as Record<string, unknown> | null)?.["herdr-web-ui:sheet"] === "string") };
}
const fake = fakeWindow();
(globalThis as unknown as { window: unknown }).window = fake.window;
// after the window: the module wraps and listens to its history as it loads
const settled = async () => { await new Promise((resolve) => setTimeout(resolve, 5)); for (let i = 0; i < 4; i++) await new Promise((resolve) => queueMicrotask(() => resolve(undefined))); };

const h = fake.window.history;
/** RowMenu's effect, without React: the hook's enter on mount and leave on unmount (sheetHistory exports them for this) */
const { enterSheet, leaveSheet } = await import("./sheetHistory.ts");
const hooks = { enter: (onBack: () => void): (() => void) => { const id = enterSheet(onBack, null); return () => leaveSheet(id); } };

afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else delete (globalThis as { window?: unknown }).window;
});

describe("a phone's sheet in the history", () => {
  it("is an entry Back closes, and leaves no entry behind when closed another way", async () => {
    let closed = 0;
    const leave = hooks.enter(() => { closed += 1; });
    expect(fake.entries.length).toBe(2); expect(fake.marks()).toEqual([false, true]);
    h.back(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(0);
    leave();
    // Cancel: the sheet's entry is stepped off after the click's effects
    const leave2 = hooks.enter(() => { closed += 1; });
    expect(fake.at()).toBe(1);
    leave2(); await settled();
    expect(fake.at()).toBe(0); expect(closed).toBe(1);
  });

  it("gives its entry to a navigation an item makes, so Back goes to the pane before and Forward returns", async () => {
    // on pane a (entry 0); the retired entry of the first test lies at 1
    const leave = hooks.enter(() => {});
    const length = fake.entries.length;
    leave();
    // the item's navigation, in the same click: another pane is an entry of its own in the app
    h.pushState({ nav: true }, "", "/?pane=b");
    await settled();
    expect(fake.entries.length).toBe(length);
    expect(fake.marks()).toEqual([false, false]);
    expect(fake.window.location.href).toBe("/?pane=b");
    h.back(); await settled();
    expect(fake.window.location.href).toBe("/?pane=a");
    h.forward(); await settled();
    expect(fake.window.location.href).toBe("/?pane=b");
  });

  it("keeps its entry for an item that changed the address on it, instead of stepping back", async () => {
    // the New tab dialog: the app replaces the entry's address while the sheet leaves
    const leave = hooks.enter(() => {});
    leave();
    h.replaceState(h.state, "", "/?pane=b&new=tab");
    await settled();
    expect(fake.window.location.href).toBe("/?pane=b&new=tab");
    expect(fake.marks().at(-1)).toBe(false);
    h.back(); await settled();
    expect(fake.window.location.href).toBe("/?pane=b");
  });

  it("reuses the entry for a sheet opened from a sheet", async () => {
    const start = fake.at();
    const leaveFirst = hooks.enter(() => {});
    leaveFirst();
    // a sheet opened from a sheet's item: the second mounts in the first's closing click
    const leaveSecond = hooks.enter(() => {});
    await settled();
    expect(fake.at()).toBe(start + 1); expect(fake.marks()[start + 1]).toBe(true);
    leaveSecond(); await settled();
    expect(fake.at()).toBe(start);
  });

  it("keeps the entry of a sheet that refuses Back while busy, and lets it go once it closes", async () => {
    const start = fake.at();
    let busy = true;
    let asked = 0;
    const leave = hooks.enter(() => { asked += 1; if (busy) return false; });
    expect(fake.at()).toBe(start + 1);
    h.back(); await settled();
    expect(asked).toBe(1);
    // the dialog stayed: its entry is back over the pane, so the next Back asks it again
    expect(fake.at()).toBe(start + 1); expect(fake.marks()[start + 1]).toBe(true);
    busy = false;
    h.back(); await settled();
    expect(asked).toBe(2); expect(fake.at()).toBe(start);
    leave(); await settled();
    expect(fake.at()).toBe(start);
  });

  it("goes on past the entry of a sheet that Back closed when Forward lands on it", async () => {
    const start = fake.at();
    let closed = 0;
    hooks.enter(() => { closed += 1; });
    h.back(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(start);
    // beyond the retired entry: nothing, so Forward stays put on it as an ordinary entry
    h.forward(); await settled();
    expect(fake.at()).toBe(start + 1); expect(fake.marks()[start + 1]).toBe(false);
  });

  it("keeps a sheet that opens while the step off a closed sheet's entry is on its way", async () => {
    const start = fake.at();
    let closed = 0;
    const leaveFirst = hooks.enter(() => {});
    fake.defer(true);
    leaveFirst();
    // the leave's step back is called, and the browser has not run it yet
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.pending()).toBe(true);
    const leaveSecond = hooks.enter(() => { closed += 1; });
    await settled();
    fake.defer(false);
    expect(fake.pending()).toBe(false);
    expect(closed).toBe(0);
    expect(fake.at()).toBe(start + 1); expect(fake.marks()[start + 1]).toBe(true);
    // its entry is an ordinary sheet's: Back closes it onto the pane, and closing it steps off nothing more
    h.back(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(start);
    leaveSecond(); await settled();
    expect(fake.at()).toBe(start);
  });
});
