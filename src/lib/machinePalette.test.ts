import { describe, expect, it } from "bun:test";
import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { translate } from "./i18n.ts";
import { availableTarget, groupMachinePanes, loadRecentTargets, rankMachinePanes, recentTargets, rememberTarget, targetKey, RECENT_KEY } from "./machinePalette.ts";

const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
const pane = (label: string, status = "idle"): HerdrPane => ({ pane_id: "p1", workspace_id: "w1", tab_id: "t1", terminal_id: "term1", revision: 1, focused: false, label, agent_status: status });
const workspace = (label: string): WorkspaceInfo => ({ workspace_id: "w1", label, active_tab_id: "t1", focused: false, number: 1, pane_count: 1, tab_count: 1, agent_status: "idle" });
function machine(id: string, name: string, label = "Shell", state: Machine["state"] = "connected"): Machine {
  return { id, name, kind: id === "local" ? "local" : "ssh", enabled: true, state, error: null,
    snapshot: { panes: [pane(label)], workspaces: [workspace("project")], tabs: [{ tab_id: "t1", workspace_id: "w1", label: "logs", focused: false, number: 1, pane_count: 1, agent_status: "idle" }], agents: [], layouts: [] } as unknown as SessionSnapshot };
}
const machines = [machine("local", "Laptop", "Dashboard"), machine("remote", "Build PC", "Database migration"), machine("offline", "Old PC", "Database migration", "disconnected")];
const search = (query: string, roster = machines) => rankMachinePanes(query, roster, "all", new Map(), t);

describe("all-PC palette", () => {
  it("namespaces identical pane/workspace IDs and selects only connected live targets", () => {
    const entries = search("");
    expect(entries.map(targetKey)).toEqual(['["local","p1"]', '["remote","p1"]']);
    expect(groupMachinePanes(entries, machines, false).map((group) => group.id)).toEqual(['["local","w1"]', '["remote","w1"]']);
    expect(availableTarget(machines, { machineId: "offline", paneId: "p1" })).toBeNull();
    expect(availableTarget(machines, { machineId: "remote", paneId: "closed" })).toBeNull();
    expect(availableTarget(machines, { machineId: "remote", paneId: "p1" })?.machine.name).toBe("Build PC");
  });
  it("searches PC names, tab names and title across every PC with global match ranking", () => {
    expect(search("Build PC").map((item) => item.machineId)).toEqual(["remote"]);
    expect(search("migration").map((item) => item.machineId)).toEqual(["remote"]);
    expect(search("logs")).toHaveLength(2);
    const list = [machine("local", "Laptop", "Log abc result"), machine("remote", "Build PC", "abc")];
    const ranked = search("abc", list);
    expect(ranked.map((item) => item.machineId)).toEqual(["remote", "local"]);
    expect(groupMachinePanes(ranked, list, true).map((item) => item.machine.id)).toEqual(["remote", "local"]);
    expect(groupMachinePanes(ranked, list, false).map((item) => item.machine.id)).toEqual(["local", "remote"]);
  });
  it("uses each PC's branches and status filters independently", () => {
    const remote = machine("remote", "Build PC");
    remote.snapshot!.panes[0]!.agent_status = "blocked";
    const branches = new Map([["remote", new Map([["w1", { branch: "feature/remote-only", checkoutPath: "/tmp/repo", isDetached: false }]])]]);
    expect(rankMachinePanes("remote-only", [machines[0]!, remote], "all", branches, t).map((entry) => entry.machineId)).toEqual(["remote"]);
    expect(rankMachinePanes("", [machines[0]!, remote], "blocked", branches, t).map((entry) => entry.machineId)).toEqual(["remote"]);
  });
  it("keeps recent targets separate, skips vanished/offline panes and excludes only the selected tuple", () => {
    const local = { machineId: "local", paneId: "p1" }; const remote = { machineId: "remote", paneId: "p1" };
    const recent = rememberTarget(remote, rememberTarget(local, [remote]));
    expect(recent).toEqual([remote, local]);
    expect(recentTargets(search(""), recent, remote, 3).map((item) => item.machineId)).toEqual(["local"]);
    expect(recentTargets(search(""), [{ machineId: "offline", paneId: "p1" }, ...recent], null, 1).map((item) => item.machineId)).toEqual(["remote"]);
    expect(targetKey({ machineId: "a:b", paneId: "c" })).not.toBe(targetKey({ machineId: "a", paneId: "b:c" }));
  });
  it("migrates local and remote legacy history once and validates the global record", () => {
    const storage = new Map<string, string>([["herdr-web-ui:recent-panes", '["p1","p1",17]'], ["herdr-web-ui:recent-panes:remote", '["p1","p2"]']]);
    const read = (key: string) => storage.get(key) ?? null;
    expect(loadRecentTargets(read, ["local", "remote"])).toEqual([{ machineId: "local", paneId: "p1" }, { machineId: "remote", paneId: "p1" }, { machineId: "remote", paneId: "p2" }]);
    storage.set(RECENT_KEY, '[{"machineId":"remote","paneId":"p2"},{"machineId":"remote","paneId":"p2"},null,7,{"machineId":1,"paneId":"x"}]');
    expect(loadRecentTargets(read, ["local", "remote"])).toEqual([{ machineId: "remote", paneId: "p2" }]);
    storage.set(RECENT_KEY, '[]'); expect(loadRecentTargets(read, ["local", "remote"])).toEqual([]);
    storage.set(RECENT_KEY, '{'); expect(loadRecentTargets(read, ["local", "remote"])).toEqual([]);
    expect(loadRecentTargets(() => { throw new Error("disabled"); }, ["local"])).toEqual([]);
  });
});
