/** One background task of an OmO session, or one subagent of a Claude Code session (GET /api/pane/omo-tasks), from OmO's task record or the subagent's files. */
export interface OmoTask {
  id: string;
  /** the task's summary, else its description or name */
  title: string;
  /** the category or agent type it ran as */
  category: string | null;
  model: string | null;
  /** `lost`: OmO's process that ran it is gone, or the pane no longer runs the Claude Code session that started it */
  status: "running" | "completed" | "failed" | "cancelled" | "lost";
  started_at: string | null;
  ended_at: string | null;
  turns: number | null;
  tool_calls: number | null;
  tokens: number | null;
}

/** One step of an OmO workflow (a DAG node); `error` is why a failed one failed. */
export interface OmoRunNode {
  id: string;
  label: string;
  state: "pending" | "scheduled" | "running" | "blocked" | "completed" | "failed" | "skipped" | "cancelled";
  error: string | null;
}

/** One OmO workflow (a DAG run): its steps by wave, a wave's steps able to run side by side. */
export interface OmoRun {
  id: string;
  name: string;
  /** `pending` and `paused` have not ended either */
  status: "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";
  started_at: string | null;
  ended_at: string | null;
  waves: OmoRunNode[][];
}

/** GET /api/pane/omo-tasks */
export interface OmoActivity {
  tasks: OmoTask[];
  runs: OmoRun[];
  /** the PC's clock, which the times are on */
  server_time: string;
}
