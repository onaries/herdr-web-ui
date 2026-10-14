import { describe, expect, test } from "bun:test";
import { formatChatTimestamp } from "./chatTimestamp.ts";
import { translate } from "./i18n.ts";

const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const now = new Date(2026, 9, 13, 15, 0).getTime();
const at = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m, d, h, min).toISOString();
const label = (ts: string | null) => formatChatTimestamp(ts, now, "en-US", t)?.label;

describe("formatChatTimestamp", () => {
  test("today shows only the time", () => {
    expect(label(at(2026, 9, 13, 0, 5))).toBe("12:05 AM");
  });
  test("yesterday is a calendar day, not 24 hours", () => {
    expect(label(at(2026, 9, 12, 23, 59))).toBe("yesterday at 11:59 PM");
  });
  test("older turns show the date, with the year once it differs", () => {
    expect(label(at(2026, 7, 13, 9, 30))).toBe("8/13 09:30 AM");
    expect(label(at(2025, 7, 13, 9, 30))).toBe("8/13/2025 09:30 AM");
  });
  test("the tooltip carries the full date", () => {
    expect(formatChatTimestamp(at(2026, 9, 12, 9, 30), now, "en-US", t)?.full).toContain("Monday, October 12, 2026");
  });
  test("a missing or invalid ts gives null", () => {
    expect(formatChatTimestamp(null, now, "en-US", t)).toBeNull();
    expect(formatChatTimestamp("nope", now, "en-US", t)).toBeNull();
  });
});
