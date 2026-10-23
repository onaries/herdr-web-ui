/**
 * One step of the plan an agent keeps for its session (GET /api/pane/plan): a task of Claude
 * Code's task list (`TaskCreate`/`TaskUpdate`), Codex's `update_plan` checklist, or OmO's `todo` list.
 */
export interface PlanStep {
  id: string;
  label: string;
  /** what it does now, in the agent's own words (Claude's `activeForm`), when it gave some */
  active: string | null;
  status: "pending" | "in_progress" | "completed";
  /** the steps it waits on: Claude's `blockedBy`, or for Codex the step before it */
  blocked_by: string[];
  /** the teammate it was given to, in a Claude Code agent team */
  owner: string | null;
  started_at: string | null;
  ended_at: string | null;
}

/** GET /api/pane/plan: the plan the pane's agent keeps now, null when it keeps none. */
export interface PanePlan {
  plan: { steps: PlanStep[] } | null;
  /** the PC's clock, which the times are on */
  server_time: string;
}
