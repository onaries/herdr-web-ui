import type { Translate } from "./i18n.ts";

export interface ChatTimestamp {
  /** Time of day; "yesterday at" before it for yesterday, the short date before it for older turns. */
  label: string;
  /** The full date and time, for a tooltip. */
  full: string;
}

const DAY_MS = 86_400_000;

/**
 * A turn's timestamp by local calendar day (not 24-hour windows): today shows the time,
 * yesterday "yesterday at <time>", older turns the short date and time, with the year
 * once the calendar year differs. Null for a missing or unparseable `ts`.
 */
export function formatChatTimestamp(ts: string | null, nowMs: number, locale: string, t: Translate): ChatTimestamp | null {
  if (ts === null) return null;
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return null;
  const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const full = date.toLocaleString(locale, { dateStyle: "full", timeStyle: "medium" });
  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  // rounded so a 23 or 25 hour DST day still counts as one day
  const dayDiff = Math.round((startOfToday - startOfDay) / DAY_MS);
  if (dayDiff <= 0) return { label: time, full };
  if (dayDiff === 1) return { label: t("yesterday at {time}", { time }), full };
  const day = date.toLocaleDateString(locale, date.getFullYear() === now.getFullYear()
    ? { month: "numeric", day: "numeric" }
    : { year: "numeric", month: "numeric", day: "numeric" });
  return { label: `${day} ${time}`, full };
}
