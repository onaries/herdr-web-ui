import { describe, expect, it } from "bun:test";
import { SCROLL_POLL_BUSY_MS, SCROLL_POLL_IDLE_MAX_MS, idleScrollPollDelay, offsetAtThumb, scrollPollDelay, scrollThumb, validScroll, visibleFindRects, type CellReader } from "./terminalViewport.ts";
const scroll = { max_offset_from_bottom: 100, offset_from_bottom: 20, viewport_rows: 2 };
const cells = (lines: string[]): CellReader => (row, col) => ({ chars: lines[row]?.[col] ?? " ", width: 1 });

describe("herdr viewport overlay", () => {
  it("maps a native wrapped range without using lost xterm wrap flags", () => {
    const match = { start: { row: 80, col: 3 }, end: { row: 81, col: 1 } };
    expect(visibleFindRects([match], scroll, "abcd", 5, 2, cells(["   ab", "cd   "]), match)).toEqual([
      { row: 0, col: 3, width: 2, current: true }, { row: 1, col: 0, width: 2, current: true },
    ]);
    expect(visibleFindRects([match], scroll, "abcd", 5, 2, cells(["   xy", "cd   "]), match)).toEqual([]);
  });
  it("keeps wide/combining cells whole, without normalizing text", () => {
    const read: CellReader = (row, col) => row === 0 ? [{ chars: "한", width: 2 }, { chars: "", width: 0 }, { chars: "e\u0301", width: 1 }][col] : undefined;
    const range = { start: { row: 80, col: 0 }, end: { row: 80, col: 2 } };
    expect(visibleFindRects([range], scroll, "한e\u0301", 3, 2, read)).toHaveLength(1);
    expect(visibleFindRects([range], scroll, "한é", 3, 2, read)).toEqual([]);
    expect(visibleFindRects([{ start: { row: 80, col: 2 }, end: { row: 80, col: 2 } }], scroll, "e", 3, 2, read)).toEqual([]);
    expect(visibleFindRects([{ start: { row: 80, col: 0 }, end: { row: 80, col: 0 } }], scroll, "한", 3, 2, read)).toEqual([]);
  });
  it("uses smart case and treats metacharacters literally", () => {
    const range = { start: { row: 80, col: 0 }, end: { row: 80, col: 2 } };
    expect(visibleFindRects([range], scroll, "a.b", 3, 2, cells(["A.B"]))).toHaveLength(1);
    expect(visibleFindRects([range], scroll, "A.b", 3, 2, cells(["a.b"]))).toEqual([]);
    expect(visibleFindRects([range], scroll, "a.b", 3, 2, cells(["axb"]))).toEqual([]);
  });
  it("rejects mismatched geometry and stale cells, clips history safely", () => {
    const range = { start: { row: 79, col: 3 }, end: { row: 80, col: 1 } };
    expect(visibleFindRects([range], scroll, "abcd", 5, 2, cells(["cd"]))).toHaveLength(1);
    expect(visibleFindRects([range], scroll, "abcd", 5, 3, cells(["cd"]))).toEqual([]);
    expect(visibleFindRects([range], scroll, "abcd", 5, 2, cells(["xx"]))).toEqual([]);
  });
});
describe("shared history scrollbar", () => {
  it("reaches both ends and roundtrips a mid-history viewport", () => {
    const thumb = scrollThumb(scroll, 200);
    expect(offsetAtThumb(scroll, thumb.top, 200, thumb.height)).toBe(20);
    expect(offsetAtThumb(scroll, -100, 200, thumb.height)).toBe(100);
    expect(offsetAtThumb(scroll, 500, 200, thumb.height)).toBe(0);
    expect(scrollThumb({ ...scroll, max_offset_from_bottom: 0, offset_from_bottom: 0 }, 200)).toEqual({ top: 0, height: 200 });
  });
  it("rejects impossible remote metrics", () => {
    expect(validScroll(scroll)).toBe(true);
    expect(validScroll({ ...scroll, viewport_rows: 0 })).toBe(false);
    expect(validScroll({ ...scroll, offset_from_bottom: 101 })).toBe(false);
    expect(validScroll({ ...scroll, max_offset_from_bottom: Infinity })).toBe(false);
  });
});

describe("scroll metrics poll", () => {
  it("backs off an idle pane from 1 s to a 15 s cap instead of asking herdr every second", () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(idleScrollPollDelay)).toEqual([1000, 2000, 4000, 8000, 15_000, 15_000, 15_000]);
    expect(idleScrollPollDelay(1e6)).toBe(SCROLL_POLL_IDLE_MAX_MS);
  });
  it("starts over at the first step for a reset or a nonsense count", () => {
    for (const reads of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(idleScrollPollDelay(reads)).toBe(1000);
    expect(idleScrollPollDelay(1.7)).toBe(2000);
  });
  it("keeps a 1 s read while scrolled up into history, where growing history may send no output", () => {
    const up = { max_offset_from_bottom: 100, offset_from_bottom: 20, viewport_rows: 24 };
    for (const reads of [0, 3, 20]) expect(scrollPollDelay(false, reads, up)).toBe(1000);
    expect(scrollPollDelay(true, 20, up)).toBe(SCROLL_POLL_BUSY_MS);
    expect(scrollPollDelay(false, 20, { ...up, offset_from_bottom: 0 })).toBe(SCROLL_POLL_IDLE_MAX_MS);
    expect(scrollPollDelay(false, 20, null)).toBe(SCROLL_POLL_IDLE_MAX_MS);
    expect(scrollPollDelay(false, 20, { ...up, offset_from_bottom: 200 })).toBe(SCROLL_POLL_IDLE_MAX_MS);
  });
  it("keeps the busy cadence below the first idle step", () => {
    expect(SCROLL_POLL_BUSY_MS).toBeLessThan(idleScrollPollDelay(0));
  });
});
