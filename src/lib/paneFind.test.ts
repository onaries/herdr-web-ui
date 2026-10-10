import { describe, expect, it } from "bun:test";
import type { PaneFindResponse } from "../../shared/protocol.ts";
import { ApiError } from "./api.ts";
import { findResultAfterError } from "./paneFind.ts";

describe("findResultAfterError", () => {
  const result: PaneFindResponse = {
    total: 2, current: 2, content_revision: 4,
    match: { start: { row: 100, col: 7 }, end: { row: 100, col: 11 } },
  };
  it("clears the previous native range on stale content", () => {
    expect(findResultAfterError(result, new ApiError("/pane/find", 409, "changed", "stale_content"))).toBeNull();
  });
  it("preserves navigation on a transport failure", () => {
    expect(findResultAfterError(result, new ApiError("/pane/find", 502, "offline", "connect_failed"))).toBe(result);
    expect(findResultAfterError(null, new Error("offline"))).toBeNull();
  });
});
