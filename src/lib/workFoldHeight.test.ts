import { describe, expect, it } from "bun:test";
import { heightFor, RESTING } from "./animatedHeight.ts";
import { contentHeightFor } from "./workFoldHeight.ts";

describe("contentHeightFor", () => {
  it("snaps an inner output resize instead of starting a virtualized row animation", () => {
    expect(contentHeightFor({ height: 120, moving: false }, 360, false)).toEqual({ height: 360, moving: false });
  });

  it("leaves the block's opening transition alone until its inner content actually changes", () => {
    const opening = heightFor(heightFor(RESTING, null), 120);
    expect(opening.moving).toBe(true);
    expect(contentHeightFor(opening, 120, false)).toBe(opening);
    expect(contentHeightFor(opening, 360, false)).toEqual({ height: 360, moving: false });
  });

  it("retains content animation for the default mode", () => {
    expect(contentHeightFor({ height: 120, moving: false }, 360, true)).toEqual({ height: 360, moving: true });
  });
});
