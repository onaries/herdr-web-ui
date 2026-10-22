import { describe, expect, it } from "bun:test";
import { DEFAULT_SETTINGS, sanitizeSettings, sharedSettings, type Settings } from "./settings.ts";
import { preferencesChange, takePreferences, type Baseline } from "./preferencesSync.ts";

const base = (settings: Settings, pins: readonly string[] | null): Baseline => ({ settings: sharedSettings(settings), pins });
const light: Settings = { ...DEFAULT_SETTINGS, theme: "light" };

describe("preferences sync", () => {
  it("sends only the shared settings that changed, and the pins only when they did", () => {
    const known = base(DEFAULT_SETTINGS, ["local:w1:p1"]);
    expect(preferencesChange(known, { settings: { ...DEFAULT_SETTINGS, terminalFontSize: 20, alertsOn: false, wrapCode: true, markdownWidth: "full" }, pins: ["local:w1:p1"] })).toBeNull();
    expect(preferencesChange(known, { settings: { ...light, terminalFontSize: 20, wrapCode: true, markdownWidth: "full" }, pins: ["local:w1:p1"] })).toEqual({ settings: { theme: "light" } });
    expect(preferencesChange(known, { settings: DEFAULT_SETTINGS, pins: [] })).toEqual({ settings: {}, pins: [] });
    expect(preferencesChange(known, { settings: { ...DEFAULT_SETTINGS, usageOrder: ["claude"] }, pins: ["local:w1:p1"] })).toEqual({ settings: { usageOrder: ["claude"] } });
  });

  it("while the server has held no pins, this browser's ride along with its first change, and alone they wait", () => {
    const unknown = base(DEFAULT_SETTINGS, null);
    expect(preferencesChange(unknown, { settings: DEFAULT_SETTINGS, pins: ["local:w1:p1"] })).toBeNull();
    expect(preferencesChange(unknown, { settings: light, pins: ["local:w1:p1"] })).toEqual({ settings: { theme: "light" }, pins: ["local:w1:p1"] });
  });

  it("takes the shared settings the server holds and leaves the device's own", () => {
    const mine: Settings = { ...light, terminalFontSize: 20, alertsOn: false, wrapCode: true, markdownWidth: "full" };
    const taken = takePreferences(base(mine, null), { settings: mine, pins: [] }, { revision: 3, settings: { theme: "dark", palette: "catppuccin" } }, null);
    expect(taken.patch).toEqual({ theme: "dark", palette: "catppuccin", darkTheme: "catppuccin" });
    expect(taken.pins).toBeNull();
    expect(taken.base).toEqual({ settings: { ...sharedSettings(mine), theme: "dark", palette: "catppuccin", darkTheme: "catppuccin" }, pins: null });
    // nothing to send once taken
    expect(preferencesChange(taken.base, { settings: { ...mine, ...taken.patch }, pins: [] })).toBeNull();
  });

  it("keeps a change made here and not yet sent, which then goes out over the server's value", () => {
    // the page opened with dark, the user chose light before the document arrived
    const taken = takePreferences(base(DEFAULT_SETTINGS, null), { settings: light, pins: [] }, { revision: 1, settings: { theme: "dark", showThinking: false } }, null);
    expect(taken.patch).toEqual({ showThinking: false });
    expect(taken.base.settings["theme"]).toBe("dark");
    expect(preferencesChange(taken.base, { settings: { ...light, showThinking: false }, pins: [] })).toEqual({ settings: { theme: "light" }, pins: [] });
  });

  it("lets a later write from elsewhere win over a value already sent, and keeps the rest of the document", () => {
    // light is on its way; meanwhile another browser set the palette, and then the theme back to dark
    const inFlight = { settings: { theme: "light" } };
    const concurrent = takePreferences(base(DEFAULT_SETTINGS, []), { settings: light, pins: [] }, { revision: 2, settings: { theme: "light", palette: "catppuccin" }, pins: [] }, inFlight);
    expect(concurrent.patch).toEqual({ theme: "light", palette: "catppuccin", lightTheme: "catppuccin" });
    const overtaken = takePreferences(base(DEFAULT_SETTINGS, []), { settings: light, pins: [] }, { revision: 3, settings: { theme: "dark" }, pins: [] }, inFlight);
    expect(overtaken.patch).toEqual({ theme: "dark" });
    expect(preferencesChange(overtaken.base, { settings: { ...light, theme: "dark" }, pins: [] })).toBeNull();
  });

  it("a refused change gives way where another browser saved the same setting or the pins since, and stays elsewhere", () => {
    // refused here: dark tokyo-night, the light side and a pin; meanwhile another browser saved its own dark theme and pins
    const local: Settings = sanitizeSettings({ ...DEFAULT_SETTINGS, darkTheme: "tokyo-night", lightTheme: "catppuccin-latte" });
    const known = base(DEFAULT_SETTINGS, ["pc:w2:p3"]);
    const remote = { revision: 4, settings: { darkTheme: "gruvbox", palette: "gruvbox", lightTheme: DEFAULT_SETTINGS.lightTheme }, pins: ["pc:w2:p3", "pc:w2:p4"] };
    const body = preferencesChange(known, { settings: local, pins: ["local:w1:p1"] })!;
    const refused = takePreferences(known, { settings: local, pins: ["local:w1:p1"] }, remote, null, false, body);
    expect(refused.patch).toEqual({ darkTheme: "gruvbox", palette: "gruvbox" });
    expect(refused.pins).toEqual(["pc:w2:p3", "pc:w2:p4"]);
    // what is left unsent is only what nobody changed elsewhere: the light side
    expect(preferencesChange(refused.base, { settings: sanitizeSettings({ ...local, ...refused.patch }), pins: refused.pins! })).toEqual({ settings: { lightTheme: "catppuccin-latte" } });
    // not refused (about to be sent): the change made here stays and goes out over them
    const pending = takePreferences(known, { settings: local, pins: ["local:w1:p1"] }, remote, null);
    expect(pending.patch).toEqual({});
    expect(pending.pins).toBeNull();
  });

  it("a value changed here after the refusal is a new change: it stays and goes out over a document that arrives later", () => {
    const known = base(DEFAULT_SETTINGS, ["pc:w2:p3"]);
    const sent: Settings = sanitizeSettings({ ...DEFAULT_SETTINGS, darkTheme: "tokyo-night" });
    const body = preferencesChange(known, { settings: sent, pins: ["pc:w2:p3", "local:w1:p1"] })!;
    // refused; then the user picked kanagawa and unpinned the pane again before any document arrived
    const now: Settings = sanitizeSettings({ ...sent, darkTheme: "kanagawa" });
    // the document that arrives (another browser's, or this browser's own refused value that landed after all)
    for (const darkTheme of ["gruvbox", "tokyo-night"]) {
      const remote = { revision: 4, settings: { darkTheme, palette: darkTheme }, pins: ["pc:w2:p3", "pc:w2:p4"] };
      const taken = takePreferences(known, { settings: now, pins: ["pc:w2:p3", "local:w1:p2"] }, remote, null, false, body);
      expect(taken.patch).toEqual({});
      expect(taken.pins).toBeNull();
      expect(preferencesChange(taken.base, { settings: now, pins: ["pc:w2:p3", "local:w1:p2"] })).toEqual({ settings: { darkTheme: "kanagawa", palette: "kanagawa" }, pins: ["pc:w2:p3", "local:w1:p2"] });
    }
  });

  it("leaves a value this browser cannot read, and does not send its own back", () => {
    const taken = takePreferences(base(DEFAULT_SETTINGS, null), { settings: DEFAULT_SETTINGS, pins: [] }, { revision: 1, settings: { theme: "purple", agentMarks: "yes", palette: "catppuccin", darkTheme: "catppuccin", lightTheme: "future-theme" } }, null);
    expect(taken.patch).toEqual({ palette: "catppuccin", darkTheme: "catppuccin" });
    expect(preferencesChange(taken.base, { settings: sanitizeSettings({ ...DEFAULT_SETTINGS, ...taken.patch }), pins: [] })).toBeNull();
  });

  it("keeps an unsent side edit over a legacy-only fixed-mode document", () => {
    const local = sanitizeSettings({ ...DEFAULT_SETTINGS, darkTheme: "tokyo-night" });
    const taken = takePreferences(base(DEFAULT_SETTINGS, []), { settings: local, pins: [] }, { revision: 2, settings: { theme: "dark", palette: "catppuccin" } }, null);
    expect(taken.patch).toEqual({ theme: "dark" });
    expect(taken.base.settings.darkTheme).toBe("catppuccin");
    expect(preferencesChange(taken.base, { settings: sanitizeSettings({ ...local, ...taken.patch }), pins: [] })).toEqual({
      settings: { palette: "tokyo-night", darkTheme: "tokyo-night" },
    });
  });

  it("joins this browser's pins to the first the server holds, then follows the last write", () => {
    const first = takePreferences(base(DEFAULT_SETTINGS, null), { settings: DEFAULT_SETTINGS, pins: ["local:w1:p1"] }, { revision: 1, settings: {}, pins: ["pc:w2:p3", "local:w1:p1"] }, null);
    expect(first.pins).toEqual(["pc:w2:p3", "local:w1:p1"]);
    expect(first.base.pins).toEqual(["pc:w2:p3", "local:w1:p1"]);
    const joined = takePreferences(base(DEFAULT_SETTINGS, null), { settings: DEFAULT_SETTINGS, pins: ["local:w1:p1"] }, { revision: 1, settings: {}, pins: ["pc:w2:p3"] }, null);
    expect(joined.pins).toEqual(["pc:w2:p3", "local:w1:p1"]);
    // the join is this browser's change: it goes out
    expect(preferencesChange(joined.base, { settings: DEFAULT_SETTINGS, pins: joined.pins! })).toEqual({ settings: {}, pins: ["pc:w2:p3", "local:w1:p1"] });
    const later = takePreferences(base(DEFAULT_SETTINGS, ["pc:w2:p3"]), { settings: DEFAULT_SETTINGS, pins: ["pc:w2:p3"] }, { revision: 2, settings: {}, pins: [] }, null);
    expect(later.pins).toEqual([]);
    // a pin made here and not yet sent stays
    const pinning = takePreferences(base(DEFAULT_SETTINGS, ["pc:w2:p3"]), { settings: DEFAULT_SETTINGS, pins: ["pc:w2:p3", "local:w1:p1"] }, { revision: 2, settings: {}, pins: [] }, null);
    expect(pinning.pins).toBeNull();
    expect(pinning.base.pins).toEqual([]);
  });

  it("a watching device takes everything", () => {
    const taken = takePreferences(base(DEFAULT_SETTINGS, ["a:b"]), { settings: light, pins: ["a:b", "c:d"] }, { revision: 5, settings: { theme: "dark" }, pins: [] }, null, true);
    expect(taken.patch).toEqual({ theme: "dark" });
    expect(taken.pins).toEqual([]);
  });
});
