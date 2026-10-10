import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiError, PaneMoved } from "../shared/protocol.ts";
import { createServer } from "./index.ts";
import { MACHINE_PROXY_PATH } from "./machine-api.ts";
import { sessionSnapshot, tabCreate, workspaceClose, workspaceCreate } from "./herdr/client.ts";

/**
 * POST /api/pane/move against a real herdr: each destination kind, the id a pane gets when it
 * leaves its workspace, and the refusals that never reach herdr. Every pane moved here lives in
 * a workspace this file created; the workspaces a move makes are closed with them.
 */
describe("POST /api/pane/move", () => {
  let server: ReturnType<typeof createServer>;
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-web-ui-pane-move-"));
  const owned = new Set<string>();
  const base = () => `http://localhost:${server.port}`;
  const post = (body: unknown, path = "/api/pane/move", headers: Record<string, string> = {}) => fetch(`${base()}${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const refused = async (response: Response, status: number, code: string): Promise<void> => {
    expect(response.status).toBe(status);
    const body = (await response.json()) as ApiError;
    expect(body.error.code).toBe(code);
    expect(typeof body.error.message).toBe("string");
  };
  const moved = async (response: Response): Promise<PaneMoved> => {
    expect(response.status).toBe(200);
    return (await response.json()) as PaneMoved;
  };

  beforeAll(() => {
    server = createServer({ port: 0, stateDir });
  });

  afterAll(async () => {
    server?.stop();
    for (const id of owned) await workspaceClose(id).catch(() => undefined);
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("refuses a malformed body before touching herdr", async () => {
    expect((await fetch(`${base()}/api/pane/move`)).status).toBe(400);
    await refused(await post("{not json"), 400, "invalid_json");
    for (const [body, code] of [
      [{ destination: { type: "new_tab" } }, "missing_pane_id"],
      [{ pane_id: "", destination: { type: "new_tab" } }, "missing_pane_id"],
      [{ pane_id: 5, destination: { type: "new_tab" } }, "missing_pane_id"],
      [{ pane_id: "w:p1" }, "invalid_destination"],
      [{ pane_id: "w:p1", destination: "new_tab" }, "invalid_destination"],
      [{ pane_id: "w:p1", destination: { type: "sideways" } }, "invalid_destination"],
      [{ pane_id: "w:p1", destination: { type: "tab" } }, "invalid_destination"],
      [{ pane_id: "w:p1", destination: { type: "tab", tab_id: "w:t1", split: "up" } }, "invalid_destination"],
      [{ pane_id: "w:p1", destination: { type: "tab", tab_id: "w:t1", ratio: "half" } }, "invalid_destination"],
      [{ pane_id: "w:p1", destination: { type: "new_tab", workspace_id: 3 } }, "invalid_destination"],
      [{ pane_id: "w:p1", destination: { type: "new_workspace", label: 7 } }, "invalid_destination"],
      [{ pane_id: "w:p1", destination: { type: "new_tab" }, focus: "yes" }, "invalid_focus"],
    ] as const) {
      await refused(await post(body), 400, code);
    }
  });

  it("answers herdr's own refusals in the error envelope", async () => {
    const own = await workspaceCreate({ cwd: tmpdir(), label: "herdr-web-ui-test-pane-move-refusals" });
    owned.add(own.workspace.workspace_id);
    await refused(await post({ pane_id: "no-such:p1", destination: { type: "new_tab" } }), 404, "pane_not_found");
    await refused(await post({ pane_id: own.root_pane.pane_id, destination: { type: "tab", tab_id: "no-such:t1" } }), 404, "tab_not_found");
    await refused(await post({ pane_id: own.root_pane.pane_id, destination: { type: "new_tab", workspace_id: "no-such" } }), 404, "workspace_not_found");
  });

  it("moves a pane through every destination kind and reports the id it answers to", async () => {
    const a = await workspaceCreate({ cwd: tmpdir(), label: "herdr-web-ui-test-pane-move-a" });
    owned.add(a.workspace.workspace_id);
    const b = await workspaceCreate({ cwd: tmpdir(), label: "herdr-web-ui-test-pane-move-b" });
    owned.add(b.workspace.workspace_id);
    const second = await tabCreate({ workspaceId: a.workspace.workspace_id });
    const paneId = second.root_pane.pane_id;

    // into another tab of its own workspace, with no split named: the id stays, the emptied tab closes
    const intoTab = await moved(await post({ pane_id: paneId, destination: { type: "tab", tab_id: a.tab.tab_id } }));
    expect(intoTab.changed).toBe(true);
    expect(intoTab.previous_pane_id).toBe(paneId);
    expect(intoTab.pane.pane_id).toBe(paneId);
    expect(intoTab.pane.tab_id).toBe(a.tab.tab_id);
    expect(intoTab.previous_tab_id).toBe(second.tab.tab_id);
    expect(intoTab.closed_tab_id).toBe(second.tab.tab_id);
    expect(intoTab.target_layout.panes.map((pane) => pane.pane_id)).toContain(paneId);

    // a new tab of its own workspace: still the same id
    const ownNewTab = await moved(await post({ pane_id: paneId, destination: { type: "new_tab" } }));
    expect(ownNewTab.pane.pane_id).toBe(paneId);
    expect(ownNewTab.pane.workspace_id).toBe(a.workspace.workspace_id);
    expect(ownNewTab.created_tab?.workspace_id).toBe(a.workspace.workspace_id);
    expect(ownNewTab.created_tab?.tab_id).toBe(ownNewTab.pane.tab_id);

    // a new tab of another workspace: a new id, reported beside the old one
    const otherNewTab = await moved(await post({ pane_id: paneId, destination: { type: "new_tab", workspace_id: b.workspace.workspace_id } }));
    expect(otherNewTab.previous_pane_id).toBe(paneId);
    expect(otherNewTab.pane.pane_id).not.toBe(paneId);
    expect(otherNewTab.previous_workspace_id).toBe(a.workspace.workspace_id);
    expect(otherNewTab.pane.workspace_id).toBe(b.workspace.workspace_id);
    expect(otherNewTab.created_tab?.workspace_id).toBe(b.workspace.workspace_id);
    expect(otherNewTab.closed_tab_id).toBe(ownNewTab.created_tab?.tab_id);

    // an existing tab of another workspace, split downward
    const otherTab = await moved(await post({ pane_id: otherNewTab.pane.pane_id, destination: { type: "tab", tab_id: b.tab.tab_id, split: "down" } }));
    expect(otherTab.pane.tab_id).toBe(b.tab.tab_id);
    expect(otherTab.closed_tab_id).toBe(otherNewTab.created_tab?.tab_id);
    expect(otherTab.target_layout.panes).toHaveLength(2);

    // a workspace of its own
    const own = await moved(await post({ pane_id: otherTab.pane.pane_id, destination: { type: "new_workspace", label: "herdr-web-ui-test-pane-move-c" } }));
    expect(own.created_workspace?.label).toBe("herdr-web-ui-test-pane-move-c");
    const created = own.created_workspace!.workspace_id;
    owned.add(created);
    expect(own.pane.pane_id).not.toBe(otherTab.pane.pane_id);
    expect(own.pane.workspace_id).toBe(created);
    expect(own.created_tab?.workspace_id).toBe(created);

    // herdr knows the pane under its last id only
    const snapshot = await sessionSnapshot();
    expect(snapshot.panes.some((pane) => pane.pane_id === own.pane.pane_id)).toBe(true);
    for (const old of [paneId, otherNewTab.pane.pane_id]) expect(snapshot.panes.some((pane) => pane.pane_id === old)).toBe(false);
    expect(snapshot.workspaces.some((workspace) => workspace.workspace_id === created)).toBe(true);

    // where it already is: nothing changes, and herdr says why
    const same = await moved(await post({ pane_id: own.pane.pane_id, destination: { type: "tab", tab_id: own.pane.tab_id } }));
    expect(same.changed).toBe(false);
    expect(same.reason).toBe("same_tab");
    expect(same.pane.pane_id).toBe(own.pane.pane_id);

    // the local-PC alias reaches it, with focus following this time; the emptied workspace closes behind the pane
    expect(MACHINE_PROXY_PATH.test("pane/move")).toBe(true);
    const back = await moved(await post(
      { pane_id: own.pane.pane_id, destination: { type: "new_tab", workspace_id: a.workspace.workspace_id }, focus: true },
      "/api/machines/local/pane/move",
      { "x-herdr-machine": "1" },
    ));
    expect(back.pane.workspace_id).toBe(a.workspace.workspace_id);
    expect(back.closed_workspace_id).toBe(created);
    expect(back.focused_pane_id).toBe(back.pane.pane_id);
    expect((await sessionSnapshot()).focused_pane_id).toBe(back.pane.pane_id);
    owned.delete(created);
  }, 30_000);
});
