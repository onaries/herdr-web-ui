import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionSnapshot } from "../shared/protocol.ts";
import * as herdr from "./herdr/client.ts";
import { HerdrError, type PluginActionInfo, type PluginCommandLog } from "./herdr/client.ts";
import { createServer } from "./index.ts";
import { pluginPaneContext } from "./plugin-actions.ts";

const PLATFORM = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
const OTHER = PLATFORM === "linux" ? "macos" : "linux";

describe("plugin routes", () => {
  const actions: PluginActionInfo[] = [
    { plugin_id: "deploy", action_id: "ship", title: "Ship", description: "Ship it", contexts: ["pane"], command: ["./ship.sh"], platforms: [PLATFORM] },
    { plugin_id: "deploy", action_id: "elsewhere", title: "Elsewhere", command: ["./other.sh"], platforms: [OTHER] },
    { plugin_id: "deploy", action_id: "anywhere", title: "Anywhere", command: ["./any.sh"] },
    { plugin_id: "notes", action_id: "jot", title: "Jot", description: null, command: ["jot"], platforms: null },
  ];
  const finished: PluginCommandLog = { log_id: "log-1", plugin_id: "deploy", action_id: "ship", status: "failed", exit_code: 2, stderr: "boom\n" };
  let server: ReturnType<typeof createServer>;
  let stateDir: string;
  const list = spyOn(herdr, "pluginList").mockImplementation(async () => [
    { plugin_id: "deploy", name: "Deploy", version: "1.0.0", description: "Ships builds", enabled: true },
    { plugin_id: "notes", name: "Notes", version: "0.1.0", enabled: false },
  ] as Awaited<ReturnType<typeof herdr.pluginList>>);
  const actionList = spyOn(herdr, "pluginActionList").mockImplementation(async () => actions);
  const logs = spyOn(herdr, "pluginLogList").mockImplementation(async () => [finished]);
  const invoke = spyOn(herdr, "pluginActionInvoke").mockImplementation(async () => ({ log: { log_id: "log-2", plugin_id: "deploy", status: "succeeded", exit_code: 0, stdout: "done" } }));
  const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
  const post = (path: string, body: unknown, method = "POST") => fetch(url(path), {
    method, headers: { "content-type": "application/json", origin: url("") }, body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const error = async (response: Response) => [response.status, ((await response.json()) as { error: { code: string } }).error.code];

  beforeAll(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ovis-plugin-routes-"));
    server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", machines: false, sidecar: false });
  });
  afterEach(() => {
    for (const spy of [list, actionList, logs, invoke]) spy.mockClear();
  });
  afterAll(() => {
    server.stop();
    for (const spy of [list, actionList, logs, invoke]) spy.mockRestore();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("lists each plugin with the actions this platform runs, without their command lines", async () => {
    const response = await fetch(url("/api/plugins/actions"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      plugins: [
        {
          plugin_id: "deploy", name: "Deploy", version: "1.0.0", description: "Ships builds", enabled: true,
          actions: [
            { action_id: "ship", title: "Ship", description: "Ship it", contexts: ["pane"] },
            { action_id: "anywhere", title: "Anywhere", description: null, contexts: [] },
          ],
        },
        { plugin_id: "notes", name: "Notes", version: "0.1.0", description: null, enabled: false, actions: [{ action_id: "jot", title: "Jot", description: null, contexts: [] }] },
      ],
    });
    expect(await error(await post("/api/plugins/actions", {}))).toEqual([400, "method_not_allowed"]);
  });

  it("answers how a run ended from the plugin's log, and what it cannot look up", async () => {
    expect(await error(await fetch(url("/api/plugin/action?log_id=log-1")))).toEqual([400, "missing_plugin_id"]);
    expect(await error(await fetch(url("/api/plugin/action?plugin_id=deploy")))).toEqual([400, "missing_log_id"]);
    const response = await fetch(url("/api/plugin/action?plugin_id=deploy&log_id=log-1"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ log_id: "log-1", status: "failed", exit_code: 2, output: "boom", opened_pane_id: null });
    expect(logs).toHaveBeenCalledWith("deploy", 200);
    expect(await error(await fetch(url("/api/plugin/action?plugin_id=deploy&log_id=gone")))).toEqual([404, "plugin_log_not_found"]);
    logs.mockImplementationOnce(async () => { throw new HerdrError("connect_failed", "herdr is not answering"); });
    expect(await error(await fetch(url("/api/plugin/action?plugin_id=deploy&log_id=log-1")))).toEqual([502, "connect_failed"]);
  });

  it("validates a run before asking herdr, and refuses other methods", async () => {
    expect(await error(await post("/api/plugin/action", "not json"))).toEqual([400, "invalid_json"]);
    expect(await error(await post("/api/plugin/action", { action_id: "ship" }))).toEqual([400, "missing_plugin_id"]);
    expect(await error(await post("/api/plugin/action", { plugin_id: "deploy" }))).toEqual([400, "missing_action_id"]);
    expect(await error(await post("/api/plugin/action", { plugin_id: "deploy", action_id: "ship", pane_id: "" }))).toEqual([400, "invalid_pane_id"]);
    expect(await error(await post("/api/plugin/action", { plugin_id: "deploy", action_id: "ship" }, "PUT"))).toEqual([400, "method_not_allowed"]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("runs an action without a pane, or with the named pane's whole context, and refuses a pane that is not there", async () => {
    const plain = await post("/api/plugin/action", { plugin_id: "deploy", action_id: "ship" });
    expect(plain.status).toBe(200);
    expect(await plain.json()).toEqual({ log_id: "log-2", status: "succeeded", exit_code: 0, output: null, opened_pane_id: null });
    expect(invoke).toHaveBeenLastCalledWith("deploy", "ship", undefined);

    const snapshot = {
      workspaces: [{ workspace_id: "w1", label: "app", worktree: null }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main", number: 1 }],
      panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/repo", agent: "claude", agent_status: "idle" }],
    } as unknown as SessionSnapshot;
    const snap = spyOn(herdr, "sessionSnapshot").mockImplementation(async () => snapshot);
    try {
      const withPane = await post("/api/plugin/action", { plugin_id: "deploy", action_id: "ship", pane_id: "w1:p1" });
      expect(withPane.status).toBe(200);
      expect(invoke).toHaveBeenLastCalledWith("deploy", "ship", pluginPaneContext(snapshot, snapshot.panes[0]!));
      invoke.mockClear();
      expect(await error(await post("/api/plugin/action", { plugin_id: "deploy", action_id: "ship", pane_id: "w9:p9" }))).toEqual([404, "pane_not_found"]);
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      snap.mockRestore();
    }
  });
});
