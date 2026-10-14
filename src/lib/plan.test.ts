import { describe, expect, it } from "bun:test";

import type { PlanStep } from "../../shared/protocol.ts";
import { planWaves } from "./plan.ts";

const step = (id: string, blocked_by: string[] = [], status: PlanStep["status"] = "pending"): PlanStep =>
  ({ id, label: `step ${id}`, active: null, status, blocked_by, owner: null, started_at: null, ended_at: null });

describe("planWaves", () => {
  it("puts a step one wave after the last step it waits on, keeping the plan's order inside a wave", () => {
    const waves = planWaves([step("1"), step("2", ["1"]), step("3", ["1"]), step("4", ["2", "3"]), step("5")]);
    expect(waves.map((wave) => wave.map((s) => s.id))).toEqual([["1", "5"], ["2", "3"], ["4"]]);
  });

  it("ignores a wait on a step that is gone and does not follow a loop", () => {
    expect(planWaves([step("1", ["9"]), step("2", ["3"]), step("3", ["2"])]).flat().map((s) => s.id).sort()).toEqual(["1", "2", "3"]);
  });
});
