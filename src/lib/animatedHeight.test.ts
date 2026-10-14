import { describe, expect, it } from "bun:test";

import { heightFor, RESTING, settled, transitionSpan, transitionTimes } from "./animatedHeight.ts";

describe("heightFor", () => {
  it("lays the box out where its content already is on the first measurement, without moving", () => {
    expect(heightFor(RESTING, 120)).toEqual({ height: 120, moving: false });
  });

  it("sets the box moving on a later measurement and rounds up to whole pixels", () => {
    const laid = heightFor(RESTING, 120);
    expect(heightFor(laid, 180.2)).toEqual({ height: 181, moving: true });
  });

  it("hands back the same state for the same height, so nothing is committed", () => {
    const laid = heightFor(RESTING, 120);
    expect(heightFor(laid, 120)).toBe(laid);
    expect(heightFor(laid, 119.5)).toBe(laid);
  });

  it("folds a laid-out box to nothing, moving", () => {
    expect(heightFor(heightFor(RESTING, 120), null)).toEqual({ height: 0, moving: true });
  });

  it("folds an unmeasured box to nothing at once: a block that mounts folded does not move", () => {
    expect(heightFor(RESTING, null)).toEqual({ height: 0, moving: false });
  });

  it("opens a folded box moving from nothing", () => {
    expect(heightFor(heightFor(RESTING, null), 96)).toEqual({ height: 96, moving: true });
  });
});

describe("settled", () => {
  it("rests a moving box at its height", () => {
    expect(settled({ height: 96, moving: true })).toEqual({ height: 96, moving: false });
  });

  it("leaves a resting box as it is", () => {
    const resting = { height: 96, moving: false };
    expect(settled(resting)).toBe(resting);
    expect(settled(RESTING)).toBe(RESTING);
  });
});

describe("transitionTimes", () => {
  it("reads seconds and milliseconds, in a list", () => {
    expect(transitionTimes("0.18s")).toEqual([180]);
    expect(transitionTimes("250ms, 1s")).toEqual([250, 1000]);
  });

  it("reads a value it cannot parse as no time", () => {
    expect(transitionTimes("")).toEqual([0]);
    expect(transitionTimes("fast")).toEqual([0]);
  });
});

describe("transitionSpan", () => {
  it("is the transition's duration plus its delay", () => {
    expect(transitionSpan("0.18s", "0s")).toBe(180);
    expect(transitionSpan("0.18s", "50ms")).toBe(230);
  });

  it("is zero when nothing moves, so the box can rest without waiting for an end event", () => {
    expect(transitionSpan("0s", "0s")).toBe(0);
    expect(transitionSpan("0s, 0s", "1s")).toBe(0);
  });

  it("takes the longest of several transitions, pairing delays the way the browser does", () => {
    expect(transitionSpan("0.2s, 1s", "0s, 100ms")).toBe(1100);
    expect(transitionSpan("0.2s, 1s, 0.5s", "300ms")).toBe(1300);
  });

  it("counts a negative delay against the duration", () => {
    expect(transitionSpan("1s", "-0.25s")).toBe(750);
  });
});
