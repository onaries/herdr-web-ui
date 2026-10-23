/** Where a plugin manifest says an action applies. herdr may add more, so it stays open. */
export type PluginActionContext = "global" | "workspace" | "tab" | "pane" | "selection" | (string & {});

/** One manifest action of a herdr plugin. Its command line stays on the server. */
export interface PluginAction {
  /** local to its plugin: herdr's global name is `<plugin_id>.<action_id>` */
  action_id: string;
  title: string;
  description: string | null;
  /** empty when the manifest names none */
  contexts: PluginActionContext[];
}

/** GET /api/plugins/actions: one installed plugin and the actions this PC can run. */
export interface PluginActions {
  plugin_id: string;
  name: string;
  version: string;
  description: string | null;
  /** herdr refuses a disabled plugin's actions (`plugin_disabled`) */
  enabled: boolean;
  actions: PluginAction[];
}

export interface PluginActionsResponse {
  plugins: PluginActions[];
}

/** POST /api/plugin/action. Without `pane_id` herdr runs the action in its own focus. */
export interface PluginActionRequest {
  plugin_id: string;
  action_id: string;
  pane_id?: string;
}

/** POST /api/plugin/action: what herdr's plugin command log said by the time the server answered. */
export interface PluginActionResult {
  /** herdr's log entry of this run: what GET /api/plugin/action is asked about while it is `running` */
  log_id: string;
  /** `running`: the command had not ended when the wait ran out */
  status: "running" | "succeeded" | "failed";
  exit_code: number | null;
  /** a failed command's own words (spawn error, else the end of stderr, else of stdout); null otherwise */
  output: string | null;
  /**
   * The pane this run's own output says it opened with focus (the answer of `herdr plugin pane
   * open --focus`), while that pane still exists. Null for everything else: a command that
   * printed no such answer, a popup (it has no pane ID), and a pane that merely appeared while
   * the command ran, which nothing ties to it.
   */
  opened_pane_id: string | null;
}
