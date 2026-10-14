import { describe, expect, it } from "bun:test";

import { chatSearchText, searchLoadedChatRows } from "./chatSearch.ts";

describe("searchLoadedChatRows", () => {
  it("finds an offscreen match from loaded source rows", () => {
    const result = searchLoadedChatRows([
      { key: "visible", text: "latest message" },
      { key: "offscreen", text: "older sentinel result" },
    ], "sentinel");

    expect(result).toEqual({
      matches: [{ rowKey: "offscreen", start: 6, end: 14 }],
      count: 1,
    });
  });

  it("returns every non-overlapping literal match with source offsets", () => {
    const result = searchLoadedChatRows([
      { key: "first", text: "alpha alpha" },
      { key: "second", text: "alpha" },
    ], "alpha");

    expect(result).toEqual({
      matches: [
        { rowKey: "first", start: 0, end: 5 },
        { rowKey: "first", start: 6, end: 11 },
        { rowKey: "second", start: 0, end: 5 },
      ],
      count: 3,
    });
  });

  it("does not manufacture matches for an empty query", () => {
    expect(searchLoadedChatRows([{ key: "row", text: "loaded text" }], "")).toEqual({ matches: [], count: 0 });
  });

  it("matches case-insensitively with offsets in the original UTF-16 source", () => {
    expect(searchLoadedChatRows([{ key: "row", text: "😀 Alpha ALPHA" }], "alpha").matches).toEqual([
      { rowKey: "row", start: 3, end: 8 },
      { rowKey: "row", start: 9, end: 14 },
    ]);
    expect(searchLoadedChatRows([{ key: "row", text: "Alpha alpha" }], "alpha", true).matches).toEqual([
      { rowKey: "row", start: 6, end: 11 },
    ]);
  });

  it("treats regex punctuation as literal source text", () => {
    expect(searchLoadedChatRows([{ key: "row", text: "a.*b axxb" }], ".*").matches).toEqual([{ rowKey: "row", start: 1, end: 3 }]);
  });

  it("includes folded tool output without treating image references as message text", () => {
    const text = chatSearchText({ role: "assistant", ts: null, parts: [
      { kind: "tool", name: "Read", summary: "file", input: "{}", output: "hidden sentinel" },
      { kind: "image", media_type: "image/png", ref: "not-searchable" },
      { kind: "text", text: "answer" },
    ] });
    expect(searchLoadedChatRows([{ key: "row", text }], "hidden sentinel").count).toBe(1);
    expect(searchLoadedChatRows([{ key: "row", text }], "not-searchable").count).toBe(0);
  });

  it("searches a whole output once the row has loaded it", () => {
    const text = chatSearchText({ role: "assistant", ts: null, parts: [
      { kind: "tool", name: "Read", summary: "file", input: "{}", output: "preview", output_ref: "out" },
    ] }, new Map([["out", "preview\nfull output sentinel"]]));
    expect(searchLoadedChatRows([{ key: "row", text }], "full output sentinel").count).toBe(1);
  });
});
