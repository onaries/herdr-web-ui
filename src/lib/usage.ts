import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderUsage, UsageProviderId, UsageReport, UsageWindow } from "../../shared/protocol.ts";
import { fetchUsage } from "./api.ts";
import type { UsageCount, UsageGlance } from "./settings.ts";
import { t } from "./i18n.ts";
import { usePageVisible } from "./visibility.ts";

/** The server asks a provider at most every 5 minutes; a minute here only picks that up sooner. */
const POLL_MS = 60_000;
/** from this much used, a limit is near enough to show in the blocked color */
export const HIGH_PERCENT = 80;

export const PROVIDER_NAME: Readonly<Record<UsageProviderId, string>> = {
  claude: "Claude", codex: "Codex", cursor: "Cursor", copilot: "Copilot", grok: "Grok", antigravity: "Antigravity", opencode: "OpenCode",
};

/** AgentMark's name for each provider's logo */
export const PROVIDER_MARK: Readonly<Record<UsageProviderId, string>> = {
  claude: "claude", codex: "codex", cursor: "cursor", copilot: "copilot", grok: "grok", antigravity: "agy", opencode: "opencode",
};

export const WINDOW_LABEL: Readonly<Record<UsageWindow["kind"], string>> = {
  session: "Session",
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
};

/** A pane's agent selects a provider, not an inferred active account. */
export function providerForAgent(agent: string | null | undefined): UsageProviderId | null {
  return (Object.keys(PROVIDER_MARK) as UsageProviderId[]).find((id) => PROVIDER_MARK[id] === agent) ?? null;
}

/** The first visible account in Settings order supplies the composer's compact reference. */
export function composerUsage(providers: readonly ProviderUsage[], agent: string | null, order: readonly string[], hidden: readonly string[]): ProviderUsage | undefined {
  const providerId = providerForAgent(agent);
  return orderProviders(providers, order).find((usage) => usage.id === providerId && !hidden.includes(usage.key));
}

/** Plan-wide five-hour session first, then week; scoped limits do not stand in for either. */
export function statusWindows(usage: ProviderUsage): UsageWindow[] {
  return (["session", "week"] as const)
    .map((kind) => usage.windows.find((window) => window.kind === kind && window.scope === null))
    .filter((window): window is UsageWindow => window !== undefined);
}

/** The limit closest to running out: what a chip shows when the plan has no limit of the chosen kind. */
export function tightestWindow(usage: ProviderUsage): UsageWindow | null {
  return usage.windows.reduce<UsageWindow | null>((tightest, window) => tightest === null || window.used_percent > tightest.used_percent ? window : tightest, null);
}

/**
 * The limit a chip shows: the plan-wide one of the kind chosen in Settings (the week, or the
 * short session), never a model's own. A plan without it shows its limit closest to running out.
 */
export function glanceWindow(usage: ProviderUsage, glance: UsageGlance): UsageWindow | null {
  return usage.windows.find((window) => window.kind === glance && window.scope === null) ?? tightestWindow(usage);
}

export function windowLabel(window: UsageWindow): string {
  const kind = t(WINDOW_LABEL[window.kind]);
  if (window.scope === null) return kind;
  const scope = window.scope === "Other models" ? t("Other models") : window.scope === "Cursor models" ? t("Cursor models") : window.scope;
  return `${kind} · ${scope}`;
}

/** A provider and, when known, whose account it is: "Codex · me@example.com". */
export function usageName(usage: ProviderUsage): string {
  return usage.account ? `${PROVIDER_NAME[usage.id]} · ${usage.account}` : PROVIDER_NAME[usage.id];
}

/** What a meter shows of a limit: the share used, or what is left. */
export function meterPercent(window: UsageWindow, count: UsageCount): number {
  return count === "left" ? Math.round((100 - window.used_percent) * 10) / 10 : window.used_percent;
}

/** A meter's value as text: "77%" used, "23% left". */
export function meterText(window: UsageWindow, count: UsageCount): string {
  const value = formatPercent(meterPercent(window, count));
  return count === "left" ? t("{percent} left", { percent: value }) : value;
}

/** "2d 4h", "3h 12m", "12m" until a reset; null when it is unknown or already past. */
export function formatResetIn(resetsAt: string | null, now: number): string | null {
  if (resetsAt === null) return null;
  const minutes = Math.ceil((Date.parse(resetsAt) - now) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes < 60) return t("{m}m", { m: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("{h}h {m}m", { h: hours, m: minutes % 60 });
  return t("{d}d {h}h", { d: Math.floor(hours / 24), h: hours % 24 });
}

/** before this share of a window has gone by, a rate says more about one burst than about the window */
const MIN_ELAPSED = 0.05;

/** How fast a limit is being used up, from what was used of the time gone by when it was read. */
export interface Pace {
  /** 0 to 1: the share of the window gone by when it was read, where an even pace would have used as much */
  elapsed: number;
  /** percent of the limit used per hour so far */
  perHour: number;
  /** ISO 8601 time the limit runs out at this rate when that comes before the reset; null when it lasts */
  runsOutAt: string | null;
}

/**
 * The pace of a window whose start and reset are known, once enough of it had gone by; null
 * otherwise, and once the window has reset. It is measured at `checkedAt`, when the share used was
 * read: numbers kept while a provider asks to slow down would otherwise look slower by the hour.
 */
export function windowPace(window: UsageWindow, checkedAt: string | null, now: number): Pace | null {
  if (window.starts_at === null || window.resets_at === null) return null;
  const start = Date.parse(window.starts_at);
  const end = Date.parse(window.resets_at);
  const read = checkedAt === null ? now : Date.parse(checkedAt);
  const elapsed = (read - start) / (end - start);
  if (!(end > start) || !(elapsed >= MIN_ELAPSED) || elapsed >= 1 || now >= end) return null;
  const used = window.used_percent;
  const runsOutAt = used > 0 && used < 100 ? start + (read - start) * 100 / used : null;
  return { elapsed, perHour: used / ((read - start) / 3_600_000), runsOutAt: runsOutAt !== null && runsOutAt < end ? new Date(runsOutAt).toISOString() : null };
}

/** A pace as text: "4.2%/h" for a session or a day, "8%/day" for a week or a month. */
export function formatRate(window: UsageWindow, pace: Pace): string {
  const daily = window.kind === "week" || window.kind === "month";
  const value = daily ? pace.perHour * 24 : pace.perHour;
  const rate = value < 0.1 ? "<0.1%" : `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
  return daily ? t("{rate}/day", { rate }) : t("{rate}/h", { rate });
}

/**
 * "Runs out in 2d 4h" when the limit runs out before it resets at the pace so far; null when it
 * lasts. Once that time has gone by the warning stays until the reset, as "Runs out before reset".
 */
export function formatRunsOut(window: UsageWindow, checkedAt: string | null, now: number): string | null {
  const runsOutAt = windowPace(window, checkedAt, now)?.runsOutAt ?? null;
  if (runsOutAt === null) return null;
  const time = formatResetIn(runsOutAt, now);
  return time ? t("Runs out in {time}", { time }) : t("Runs out before reset");
}

/** Percent as the meters print it: whole numbers, except the tenth that keeps a sliver above 0 visible. */
export function formatPercent(value: number): string {
  return value > 0 && value < 1 ? `${value.toFixed(1)}%` : `${Math.round(value)}%`;
}

/** The accounts in the user's order (`order`, by key), then the rest as the server lists them. */
export function orderProviders(providers: readonly ProviderUsage[], order: readonly string[] = []): ProviderUsage[] {
  const rank = new Map(order.map((key, index) => [key, index]));
  return [...providers].sort((a, b) => {
    const ranked = [rank.get(a.key), rank.get(b.key)];
    if (ranked[0] !== undefined && ranked[1] !== undefined) return ranked[0] - ranked[1];
    if (ranked[0] !== undefined || ranked[1] !== undefined) return ranked[0] !== undefined ? -1 : 1;
    return 0;
  });
}

/**
 * The order after moving `key` one place up or down among the accounts shown (`shown`, in their
 * current order). Accounts remembered but not reported now keep their place after them.
 */
export function moveInOrder(shown: readonly string[], saved: readonly string[], key: string, by: -1 | 1): string[] {
  const next = [...shown];
  const from = next.indexOf(key);
  const to = from + by;
  if (from < 0 || to < 0 || to >= next.length) return [...shown, ...saved.filter((known) => !shown.includes(known))];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return [...next, ...saved.filter((known) => !shown.includes(known))];
}

export function useUsage(enabled: boolean) {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const visible = usePageVisible();
  const generation = useRef(0);

  const load = useCallback(async (refresh: boolean) => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const next = await fetchUsage(refresh);
      if (current === generation.current) setReport((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    } catch { /* offline or restarting: the last report stays */ }
    finally { if (current === generation.current) setLoading(false); }
  }, []);

  useEffect(() => {
    if (!enabled) { generation.current++; setReport(null); setLoading(false); return; }
    if (!visible) return;
    void load(false);
    const timer = setInterval(() => void load(false), POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, visible, load]);

  const refresh = useCallback(() => void load(true), [load]);
  return { report, loading, refresh };
}
