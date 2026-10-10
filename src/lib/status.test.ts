import { describe, expect, it } from "bun:test";

import { paneStatus, rollupStatus, statusEdgeRead } from "./status.ts";

describe("rollupStatus", () => {
  it("rolls a workspace's panes up as herdr does: blocked, then done, then working, then ready", () => {
    expect(rollupStatus(["idle", "blocked", "working"])).toBe("blocked");
    expect(rollupStatus(["blocked", "done"])).toBe("blocked");
    expect(rollupStatus(["done", "working"])).toBe("done");
    expect(rollupStatus(["idle", "working"])).toBe("working");
    expect(rollupStatus(["idle", "done"])).toBe("done");
    expect(rollupStatus(["idle", undefined])).toBe("idle");
  });

  it("puts a pane waiting on its background work after working and before ready", () => {
    expect(rollupStatus(["waiting", "idle"])).toBe("waiting");
    expect(rollupStatus(["waiting", "working"])).toBe("working");
    expect(rollupStatus(["done", "waiting", "idle"])).toBe("done");
  });
});

describe("paneStatus", () => {
  it("reads a pane at rest that waits on its turn's background work as BG, and any other as its status", () => {
    expect(paneStatus({ agent_status: "done", background_wait: true })).toBe("waiting");
    expect(paneStatus({ agent_status: "idle", background_wait: true })).toBe("waiting");
    expect(paneStatus({ agent_status: "working", background_wait: true })).toBe("working");
    expect(paneStatus({ agent_status: "blocked", background_wait: true })).toBe("blocked");
    expect(paneStatus({ agent_status: "done" })).toBe("done");
  });

  it("is unknown only when no pane says more", () => {
    expect(rollupStatus([undefined, "unknown", "something-new"])).toBe("unknown");
    expect(rollupStatus([])).toBe("unknown");
  });
});

describe("statusEdgeRead", () => {
  it("reads at once when a turn starts or ends", () => {
    expect(statusEdgeRead("working", "done")).toBe(true);
    expect(statusEdgeRead("working", "idle")).toBe(true);
    expect(statusEdgeRead("working", "blocked")).toBe(true);
    expect(statusEdgeRead("idle", "working")).toBe(true);
    expect(statusEdgeRead("done", "working")).toBe(true);
    expect(statusEdgeRead(undefined, "working")).toBe(true);
  });

  it("leaves an unchanged status and changes that neither start nor end a turn to the poll", () => {
    expect(statusEdgeRead("working", "working")).toBe(false);
    expect(statusEdgeRead("idle", "idle")).toBe(false);
    expect(statusEdgeRead("idle", "done")).toBe(false);
    expect(statusEdgeRead("blocked", "idle")).toBe(false);
    expect(statusEdgeRead(undefined, undefined)).toBe(false);
  });
});
