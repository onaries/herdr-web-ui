import { describe, expect, it } from "bun:test";

import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import type { PluginCommandLog } from "./herdr/client.ts";
import { openedPluginPane, pluginActionResult, pluginLogEntry, pluginPaneContext, waitForPluginAction } from "./plugin-actions.ts";

const pane = (fields: Partial<HerdrPane>): HerdrPane => ({ pane_id: "w2:p1", workspace_id: "w2", tab_id: "w2:t1", terminal_id: "term", focused: false, agent_status: "unknown", revision: 0, ...fields });
const worktree = { repo_key: "/repo/.git", repo_name: "repo", repo_root: "/repo", checkout_path: "/repo-feature", is_linked_worktree: true };
const snapshot = (panes: HerdrPane[]): SessionSnapshot => ({
  focused_pane_id: "w1:p1",
  workspaces: [
    { workspace_id: "w1", label: "feature", number: 1, focused: true, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "working", worktree },
    { workspace_id: "w2", label: "notes", number: 2, focused: false, pane_count: 1, tab_count: 1, active_tab_id: "w2:t1", agent_status: "unknown" },
  ],
  tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "1" }, { tab_id: "w2:t1", workspace_id: "w2", label: "scratch" }],
  panes,
} as unknown as SessionSnapshot);

const opened = (paneId: string, focused = true) => JSON.stringify({ id: "cli:plugin", result: { plugin_pane: { entrypoint: "board", pane: { pane_id: paneId, focused }, plugin_id: "example.board" }, type: "plugin_pane_opened" } });
const log = (fields: Partial<PluginCommandLog>): PluginCommandLog => ({ log_id: "plugin-log-7", plugin_id: "example.board", action_id: "open", status: "succeeded", exit_code: 0, ...fields });

describe("pluginPaneContext", () => {
  it("sends every field for a shell pane outside a repository, so herdr fills none from the agent it focuses in a worktree", () => {
    const shell = pane({ cwd: "/home/me/notes" });
    const agent = pane({ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", focused: true, agent: "claude", agent_status: "working", cwd: "/repo-feature" });
    expect(pluginPaneContext(snapshot([agent, shell]), shell)).toEqual({
      workspace_id: "w2",
      workspace_label: "notes",
      workspace_cwd: "/home/me/notes",
      worktree: { repo_key: "", repo_name: "", repo_root: "", checkout_path: "", is_linked_worktree: false },
      tab_id: "w2:t1",
      tab_label: "scratch",
      focused_pane_id: "w2:p1",
      focused_pane_cwd: "/home/me/notes",
      focused_pane_agent: "",
      focused_pane_status: "unknown",
      invocation_source: "herdr-web-ui",
    });
  });

  it("gives an agent pane in a worktree its own agent, checkout and foreground directory", () => {
    const agent = pane({ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "claude", agent_status: "working", cwd: "/repo-feature", foreground_cwd: "/repo-feature/src" });
    expect(pluginPaneContext(snapshot([agent]), agent)).toMatchObject({ workspace_label: "feature", worktree, focused_pane_agent: "claude", focused_pane_status: "working", workspace_cwd: "/repo-feature/src", focused_pane_cwd: "/repo-feature/src" });
  });

  it("leaves no field out for a pane herdr reports no directory for", () => {
    const bare = pane({});
    const context = pluginPaneContext(snapshot([bare]), bare);
    expect(context.workspace_cwd).toBe("");
    expect(context.focused_pane_cwd).toBe("");
    expect(Object.values(context).every((value) => value !== undefined && value !== null)).toBe(true);
  });
});

describe("openedPluginPane", () => {
  it("names the pane the run's own output says it opened with focus", () => {
    expect(openedPluginPane(opened("w2:p4"))).toBe("w2:p4");
    expect(openedPluginPane(`arranging\n${opened("w2:p4")}\ndone\n`)).toBe("w2:p4");
  });

  it("names none for a run that printed no such answer, opened without focus, or printed something else", () => {
    expect(openedPluginPane(null)).toBeNull();
    expect(openedPluginPane("")).toBeNull();
    expect(openedPluginPane("slow-done\n")).toBeNull();
    expect(openedPluginPane(opened("w2:p4", false))).toBeNull();
    expect(openedPluginPane('{"result":{"type":"plugin_pane_focused","plugin_pane":{"pane":{"pane_id":"w2:p4","focused":true}}}}')).toBeNull();
    expect(openedPluginPane('plugin_pane_opened {"not json')).toBeNull();
  });
});

describe("pluginActionResult", () => {
  it("attributes no pane to a run that named none, whatever appeared meanwhile", async () => {
    let asked = 0;
    const result = await pluginActionResult(log({ stdout: "slow-done\n" }), async () => { asked += 1; return ["w2:p1", "w2:p9"]; });
    expect(result).toEqual({ log_id: "plugin-log-7", status: "succeeded", exit_code: 0, output: null, opened_pane_id: null });
    expect(asked).toBe(0);
  });

  it("names the pane the run opened while it exists, and none once it is gone", async () => {
    expect((await pluginActionResult(log({ stdout: opened("w2:p4") }), async () => ["w2:p1", "w2:p4"])).opened_pane_id).toBe("w2:p4");
    expect((await pluginActionResult(log({ stdout: opened("w2:p4") }), async () => ["w2:p1"])).opened_pane_id).toBeNull();
  });

  it("says a run still under way is running, and a failed one in its own last words", async () => {
    expect(await pluginActionResult(log({ status: "running", exit_code: null, stdout: opened("w2:p4") }), async () => ["w2:p4"])).toEqual({ log_id: "plugin-log-7", status: "running", exit_code: null, output: null, opened_pane_id: null });
    expect(await pluginActionResult(log({ status: "failed", exit_code: 3, stderr: `${"x".repeat(3000)}\nboom\n` }), async () => [])).toMatchObject({ status: "failed", exit_code: 3, output: expect.stringMatching(/^x{1995}\nboom$/) });
    expect((await pluginActionResult(log({ status: "failed", exit_code: null, error: "No such file", stderr: "ignored" }), async () => [])).output).toBe("No such file");
  });
});

describe("waitForPluginAction", () => {
  it("gives each log read only what is left of the wait, and answers running when a read fails", async () => {
    const timeouts: number[] = [];
    const result = await waitForPluginAction(log({ status: "running", exit_code: null }), 300, async (timeoutMs) => {
      timeouts.push(timeoutMs);
      throw new Error("herdr plugin.log.list timed out");
    }, async () => []);
    expect(result).toEqual({ log_id: "plugin-log-7", status: "running", exit_code: null, output: null, opened_pane_id: null });
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeGreaterThan(0);
    expect(timeouts[0]).toBeLessThanOrEqual(300);
  });

  it("bounds the pane lookup after the run and keeps the run's answer when that lookup fails", async () => {
    const timeouts: number[] = [];
    const ended = log({ stdout: opened("w2:p4") });
    const result = await waitForPluginAction(log({ status: "running", exit_code: null }), 300, async () => [ended], async (timeoutMs) => {
      timeouts.push(timeoutMs);
      throw new Error("herdr session.snapshot timed out");
    });
    expect(result).toEqual({ log_id: "plugin-log-7", status: "succeeded", exit_code: 0, output: null, opened_pane_id: null });
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeLessThanOrEqual(1_000);
  });

  it("names the pane a run that ended within the wait opened", async () => {
    const result = await waitForPluginAction(log({ status: "running", exit_code: null }), 300, async () => [log({ stdout: opened("w2:p4") })], async () => ["w2:p4"]);
    expect(result.opened_pane_id).toBe("w2:p4");
  });
});

describe("pluginLogEntry", () => {
  // herdr's log, newest first, answering with at most `limit` of the 200 entries it keeps
  const herdrLog = (entries: PluginCommandLog[]) => async (limit: number) => entries.slice(0, limit);

  it("finds a long run behind 60 newer runs of the same plugin, and fails once herdr dropped it", async () => {
    const newer = Array.from({ length: 60 }, (_, index) => log({ log_id: `plugin-log-${100 - index}` }));
    const late = log({ log_id: "plugin-log-7", status: "failed", exit_code: 1, stderr: "boom" });
    expect(await pluginLogEntry("plugin-log-7", herdrLog([...newer, late]))).toEqual(late);
    await expect(pluginLogEntry("plugin-log-6", herdrLog([...newer, late]))).rejects.toMatchObject({ code: "plugin_log_not_found" });
  });
});
