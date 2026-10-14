import { describe, expect, it } from "bun:test";
import type { ProviderUsage, UsageWindow } from "../../shared/protocol.ts";
import { composerUsage, formatPercent, formatRate, formatResetIn, formatRunsOut, glanceWindow, meterPercent, meterText, moveInOrder, orderProviders, providerForAgent, statusWindows, tightestWindow, usageName, windowLabel, windowPace } from "./usage.ts";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const window = (used_percent: number, kind: UsageWindow["kind"] = "week", scope: string | null = null): UsageWindow => ({ kind, scope, used_percent, resets_at: null, starts_at: null });
const provider = (id: ProviderUsage["id"], windows: UsageWindow[], account: string | null = null): ProviderUsage => ({
  id, key: account ? `${id}:${account}` : id, account, plan: null, windows, problem: null, checked_at: null,
});

describe("usage meters", () => {
  it("uses the agent's provider and the first visible account in Settings order", () => {
    const accounts = [provider("claude", [window(40)]), provider("codex", [window(20)], "a@x"), provider("codex", [window(80)], "b@x")];
    expect(composerUsage(accounts, "codex", ["codex:b@x"], [])?.account).toBe("b@x");
    expect(composerUsage(accounts, "codex", ["codex:b@x"], ["codex:b@x"])?.account).toBe("a@x");
    expect(composerUsage(accounts, "pi", [], [])).toBeUndefined();
    expect(composerUsage(accounts, null, [], [])).toBeUndefined();
    expect(providerForAgent("agy")).toBe("antigravity");
    expect(providerForAgent("opencode")).toBe("opencode");
  });

  it("prioritizes the plan-wide five-hour session, with weekly fallback only", () => {
    expect(statusWindows(provider("claude", [window(99, "week", "Sonnet"), window(84), window(22, "session")]))).toEqual([window(22, "session"), window(84)]);
    expect(statusWindows(provider("codex", [window(84)]))).toEqual([window(84)]);
    expect(statusWindows(provider("claude", [window(22, "session", "Opus"), window(84)]))).toEqual([window(84)]);
    expect(statusWindows(provider("cursor", [window(80, "month")]))).toEqual([]);
  });
  it("shows the limit closest to running out", () => {
    expect(tightestWindow(provider("codex", [window(12, "session"), window(77)]))).toEqual(window(77));
    expect(tightestWindow(provider("claude", []))).toBeNull();
  });

  it("shows the chosen limit of the whole plan, and the closest to running out where a plan has none", () => {
    const claude = provider("claude", [window(80, "session"), window(30), window(95, "week", "Sonnet")]);
    expect(glanceWindow(claude, "week")).toEqual(window(30));
    expect(glanceWindow(claude, "session")).toEqual(window(80, "session"));
    expect(glanceWindow(provider("codex", [window(30)]), "session")).toEqual(window(30));
    expect(glanceWindow(provider("cursor", [window(20, "month"), window(60, "month", "Premium")]), "week")).toEqual(window(60, "month", "Premium"));
    expect(glanceWindow(provider("grok", []), "week")).toBeNull();
  });

  it("keeps the server's order until the user arranges the accounts", () => {
    const order = orderProviders([provider("claude", []), provider("codex", [window(40)]), provider("copilot", [window(90, "month")])]);
    expect(order.map((usage) => usage.id)).toEqual(["claude", "codex", "copilot"]);
  });

  it("follows the user's order first, then the server's", () => {
    const providers = [provider("claude", [window(10)]), provider("codex", [window(40)], "a@x"), provider("codex", [window(90)], "b@x"), provider("grok", [window(50)])];
    const keys = (order: string[]) => orderProviders(providers, order).map((usage) => usage.key);
    expect(keys([])).toEqual(["claude", "codex:a@x", "codex:b@x", "grok"]);
    expect(keys(["claude", "codex:a@x", "gone"])).toEqual(["claude", "codex:a@x", "codex:b@x", "grok"]);
  });

  it("moves an account one place and keeps accounts not reported now", () => {
    expect(moveInOrder(["a", "b", "c"], ["x", "b"], "c", -1)).toEqual(["a", "c", "b", "x"]);
    expect(moveInOrder(["a", "b", "c"], [], "a", -1)).toEqual(["a", "b", "c"]);
    expect(moveInOrder(["a", "b"], [], "a", 1)).toEqual(["b", "a"]);
  });

  it("counts a meter as used or left, and names the account", () => {
    expect(meterPercent(window(77.4), "used")).toBe(77.4);
    expect(meterPercent(window(77.4), "left")).toBe(22.6);
    expect(meterText(window(77), "used")).toBe("77%");
    expect(meterText(window(77), "left")).toBe("23% left");
    expect(usageName(provider("codex", [], "me@example.com"))).toBe("Codex · me@example.com");
    expect(usageName(provider("grok", []))).toBe("Grok");
  });

  it("formats the time to a reset, and nothing for a past or unknown one", () => {
    const at = (ms: number) => new Date(NOW + ms).toISOString();
    expect(formatResetIn(at(12 * 60_000), NOW)).toBe("12m");
    expect(formatResetIn(at(3 * 3600_000 + 5 * 60_000), NOW)).toBe("3h 5m");
    expect(formatResetIn(at(23 * 3600_000 + 59 * 60_000), NOW)).toBe("23h 59m");
    expect(formatResetIn(at(50 * 3600_000), NOW)).toBe("2d 2h");
    expect(formatResetIn(at(-1000), NOW)).toBeNull();
    expect(formatResetIn(null, NOW)).toBeNull();
  });

  it("keeps a sliver above zero visible and rounds the rest", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.4)).toBe("0.4%");
    expect(formatPercent(2.2)).toBe("2%");
    expect(formatPercent(99.6)).toBe("100%");
  });

  it("projects when a limit runs out at its pace so far, and only when that comes before the reset", () => {
    const at = (hours: number) => new Date(NOW + hours * 3600_000).toISOString();
    const span = (used: number, start: number, end: number, kind: UsageWindow["kind"] = "week"): UsageWindow => ({ ...window(used, kind), starts_at: at(start), resets_at: at(end) });
    // a week 2 days in, 40% used: 20%/day, out in 3 days, 2 days before the reset
    const fast = windowPace(span(40, -48, 120), null, NOW)!;
    expect(fast.elapsed).toBeCloseTo(2 / 7);
    expect(fast.runsOutAt).toBe(at(72));
    expect(formatRate(span(40, -48, 120), fast)).toBe("20%/day");
    // 10% two days in lasts the week
    expect(windowPace(span(10, -48, 120), null, NOW)).toMatchObject({ runsOutAt: null });
    // a session 2 hours in, 9% used
    expect(formatRate(span(9, -2, 3, "session"), windowPace(span(9, -2, 3, "session"), null, NOW)!)).toBe("4.5%/h");
    expect(formatRate(span(0.01, -2, 3, "session"), windowPace(span(0.01, -2, 3, "session"), null, NOW)!)).toBe("<0.1%/h");
    // numbers read 3 hours ago, kept while the provider asks to slow down: measured when they were read
    expect(windowPace(span(50, -4, 1, "session"), at(-3), NOW)).toMatchObject({ elapsed: 0.2, perHour: 50, runsOutAt: at(-2) });
    // nothing used yet still shows how much of the window has gone by
    expect(windowPace(span(0, -2, 3, "session"), null, NOW)).toEqual({ elapsed: 0.4, perHour: 0, runsOutAt: null });
    expect(windowPace(span(100, -2, 3, "session"), null, NOW)!.runsOutAt).toBeNull();
    // too early for a rate, past the reset, or a window whose start the provider does not state
    expect(windowPace(span(5, -0.1, 4.9, "session"), null, NOW)).toBeNull();
    expect(windowPace(span(5, -6, -1, "session"), null, NOW)).toBeNull();
    expect(windowPace(span(5, -4, 1, "session"), at(-3), NOW + 2 * 3600_000)).toBeNull();
    expect(windowPace({ ...window(40), resets_at: at(120) }, null, NOW)).toBeNull();
  });

  it("keeps the run-out warning until the reset, once its time has gone by", () => {
    const at = (hours: number) => new Date(NOW + hours * 3600_000).toISOString();
    const span = (used: number, start: number, end: number): UsageWindow => ({ ...window(used, "session"), starts_at: at(start), resets_at: at(end) });
    // 50% one hour in, read 3 hours ago: out 2 hours ago at that pace, an hour before the reset
    expect(formatRunsOut(span(50, -4, 1), at(-3), NOW)).toBe("Runs out before reset");
    expect(formatRunsOut(span(50, -4, 1), at(-3), NOW - 3 * 3600_000 + 60_000)).toBe("Runs out in 59m");
    expect(formatRunsOut(span(10, -4, 1), at(-3), NOW)).toBeNull();
    expect(formatRunsOut(span(50, -4, 1), at(-3), NOW + 2 * 3600_000)).toBeNull();
  });

  it("names a window by its span and its scope", () => {
    expect(windowLabel(window(1, "session"))).toBe("Session");
    expect(windowLabel(window(1, "week", "Sonnet"))).toBe("Weekly · Sonnet");
    expect(windowLabel(window(1, "month", "Premium"))).toBe("Monthly · Premium");
    expect(windowLabel(window(1, "month", "Cursor models"))).toBe("Monthly · Cursor models");
  });
});
