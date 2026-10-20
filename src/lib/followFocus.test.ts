import { describe, expect, it } from "bun:test";
import { followsHerdrFocus } from "./followFocus.ts";

const base = {
  enabled: true,
  machineId: "local",
  paneId: "w1:p2",
  selection: { machineId: "local", paneId: "w1:p1" },
  splitOther: null,
  linkPending: false,
};

describe("following herdr's focus", () => {
  it("opens the pane herdr's focus moved to on the PC this device has open", () => {
    expect(followsHerdrFocus(base)).toBe(true);
    expect(followsHerdrFocus({ ...base, selection: { machineId: "local", paneId: null } })).toBe(true);
  });

  it("does nothing until this device turns it on", () => {
    expect(followsHerdrFocus({ ...base, enabled: false })).toBe(false);
  });

  it("leaves another PC's focus to that PC", () => {
    expect(followsHerdrFocus({ ...base, machineId: "remote" })).toBe(false);
  });

  it("leaves a pane already in front where it is", () => {
    expect(followsHerdrFocus({ ...base, paneId: "w1:p1" })).toBe(false);
    expect(followsHerdrFocus({ ...base, splitOther: { machineId: "local", paneId: "w1:p2" } })).toBe(false);
    expect(followsHerdrFocus({ ...base, splitOther: { machineId: "remote", paneId: "w1:p2" } })).toBe(true);
  });

  it("lets a link that is still landing go first", () => {
    expect(followsHerdrFocus({ ...base, linkPending: true })).toBe(false);
  });
});
