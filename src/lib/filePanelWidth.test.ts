import { describe, expect, it } from "bun:test";

import { clampFilePanelWidth, filePanelMaxWidth, FILE_PANEL_MAX_WIDTH, FILE_PANEL_MIN_WIDTH, FILE_PANEL_WIDTH_STEP, keyedFilePanelWidth, parseFilePanelWidth } from "./filePanelWidth.ts";

describe("clampFilePanelWidth", () => {
  it("keeps the width between the two limits, in whole pixels", () => {
    expect(clampFilePanelWidth(100)).toBe(FILE_PANEL_MIN_WIDTH);
    expect(clampFilePanelWidth(9000)).toBe(FILE_PANEL_MAX_WIDTH);
    expect(clampFilePanelWidth(433.6)).toBe(434);
  });

  it("never lets the panel take more than 60% of a narrow window", () => {
    expect(filePanelMaxWidth(1000)).toBe(600);
    expect(clampFilePanelWidth(800, 1000)).toBe(600);
    expect(filePanelMaxWidth(2000)).toBe(FILE_PANEL_MAX_WIDTH);
    expect(clampFilePanelWidth(800, 400)).toBe(80);
  });

  it("reserves a 320px pane after the sidebar at the docking boundary", () => {
    expect(filePanelMaxWidth(980, 490)).toBe(170);
    expect(filePanelMaxWidth(981, 490.5)).toBe(170);
    expect(clampFilePanelWidth(900, 980, 490)).toBe(170);
    expect(clampFilePanelWidth(320, 1280, 520)).toBe(320);
    expect(filePanelMaxWidth(1280, 520)).toBe(440);
    expect(filePanelMaxWidth(980, 0)).toBe(588);
    expect(keyedFilePanelWidth(170, "Home", 980, 490)).toBe(170);
    expect(keyedFilePanelWidth(170, "End", 980, 490)).toBe(170);
    expect(keyedFilePanelWidth(170, "ArrowLeft", 980, 490)).toBe(170);
    expect(keyedFilePanelWidth(170, "ArrowRight", 980, 490)).toBe(170);
  });
});

describe("keyedFilePanelWidth", () => {
  it("widens with ArrowLeft and narrows with ArrowRight, as the edge is on the left", () => {
    expect(keyedFilePanelWidth(400, "ArrowLeft")).toBe(400 + FILE_PANEL_WIDTH_STEP);
    expect(keyedFilePanelWidth(400, "ArrowRight")).toBe(400 - FILE_PANEL_WIDTH_STEP);
    expect(keyedFilePanelWidth(FILE_PANEL_MIN_WIDTH, "ArrowRight")).toBe(FILE_PANEL_MIN_WIDTH);
    expect(keyedFilePanelWidth(FILE_PANEL_MAX_WIDTH, "ArrowLeft")).toBe(FILE_PANEL_MAX_WIDTH);
  });

  it("moves to a limit with Home and End", () => {
    expect(keyedFilePanelWidth(400, "Home")).toBe(FILE_PANEL_MIN_WIDTH);
    expect(keyedFilePanelWidth(400, "End", 1000)).toBe(600);
  });

  it("leaves every other key alone", () => {
    expect(keyedFilePanelWidth(400, "Enter")).toBeNull();
    expect(keyedFilePanelWidth(400, "a")).toBeNull();
  });
});

describe("parseFilePanelWidth", () => {
  it("reads a stored width and clamps it", () => {
    expect(parseFilePanelWidth("480")).toBe(480);
    expect(parseFilePanelWidth("12")).toBe(FILE_PANEL_MIN_WIDTH);
  });

  it("falls back to the default width for anything else", () => {
    expect(parseFilePanelWidth(null)).toBeNull();
    expect(parseFilePanelWidth("")).toBeNull();
    expect(parseFilePanelWidth("wide")).toBeNull();
    expect(parseFilePanelWidth("480px")).toBeNull();
  });
});
