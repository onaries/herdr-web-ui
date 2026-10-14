import { describe, expect, it } from "bun:test";
import { aggregateFailures, parseLaneLog } from "./ci-flakes.ts";

describe("Browser lane log parsing", () => {
  it("reads a pre-retry final failure", () => {
    const log = `FAILED scripts/terminal-input-regression.ts (exit 1), full log: /tmp/input.log
AssertionError: input regression timed out
  at /w/repo/scripts/terminal-input-regression.ts:65:32`;
    expect(parseLaneLog(log)).toEqual([{ script: "scripts/terminal-input-regression.ts", outcome: "failed", site: "scripts/terminal-input-regression.ts:65", message: "AssertionError: input regression timed out" }]);
  });
  it("separates flaky and twice-failed sections after stripping timestamps and ANSI", () => {
    const log = [
      "\u001b[33mFLAKY scripts/ui-regression.ts: failed, then passed when run again; first log: /tmp/ui.log\u001b[0m",
      "TimeoutError: waitFor: Timeout 30000ms exceeded.",
      "  at /w/repo/node_modules/playwright-core/lib/coreBundle.js:57694:13",
      "  at checkSplitView (/w/repo/scripts/split-view-regression.ts:509:13)",
      "FAILED scripts/deep-link-demo-regression.ts (exit 1, twice), full log: /tmp/deep.log",
      "AssertionError: broken link",
      "  at /w/repo/scripts/deep-link-demo-regression.ts:12:1",
    ].map((line) => `2026-10-14T00:03:56.1234567Z ${line}`).join("\n");
    expect(parseLaneLog(log)).toEqual([
      { script: "scripts/ui-regression.ts", outcome: "flaky", site: "scripts/split-view-regression.ts:509", message: "TimeoutError: waitFor: Timeout 30000ms exceeded." },
      { script: "scripts/deep-link-demo-regression.ts", outcome: "failed", site: "scripts/deep-link-demo-regression.ts:12", message: "AssertionError: broken link" },
    ]);
  });
  it("reads no failures from a clean log", () => {
    expect(parseLaneLog("PASS scripts/ui-regression.ts\nTotal: 1/1 passed")).toEqual([]);
  });
  it("keeps unrecognised failures without borrowing another section's site", () => {
    expect(parseLaneLog(`FLAKY scripts/ui-regression.ts: failed once
FAILED scripts/deep-link-demo-regression.ts (exit 1, twice), full log: /tmp/deep.log
TypeError: broken`)).toEqual([
      { script: "scripts/ui-regression.ts", outcome: "flaky", site: null, message: null },
      { script: "scripts/deep-link-demo-regression.ts", outcome: "failed", site: null, message: "TypeError: broken" },
    ]);
  });
});

describe("Failure ranking", () => {
  it("ranks combined frequency and keeps the most recent run and branch", () => {
    const common = { script: "scripts/ui-regression.ts", site: "scripts/ui-regression.ts:10", message: "AssertionError: broken" };
    const rows = aggregateFailures([
      { ...common, outcome: "flaky", runId: 3, branch: "new", createdAt: "2026-10-14T03:00:00Z" },
      { ...common, outcome: "failed", runId: 1, branch: "old", createdAt: "2026-10-14T01:00:00Z" },
      { ...common, site: null, outcome: "failed", runId: 4, branch: "other", createdAt: "2026-10-14T04:00:00Z" },
    ]);
    expect(rows.map((row) => [row.site, row.failed, row.flaky, row.runId, row.branch])).toEqual([
      ["scripts/ui-regression.ts:10", 1, 1, 3, "new"], [null, 1, 0, 4, "other"],
    ]);
  });
});
