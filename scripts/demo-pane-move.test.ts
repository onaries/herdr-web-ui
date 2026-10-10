import assert from "node:assert/strict";
import { it } from "bun:test";

/** The demo moves a pane as herdr does: the id stays inside a workspace and changes across one, and what the move empties closes. */
it("the demo moves a pane between tabs and workspaces under the ids herdr would give", async () => {
  const saved = new Map(["window", "location", "PushManager"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    const storage = new Map<string, string>();
    (globalThis as any).location = new URL("http://demo.test/demo/app/");
    (globalThis as any).window = {
      fetch, WebSocket, EventSource: class {},
      localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    };
    const transport = "../site/demo/transport.ts?pane-move";
    await import(transport);
    const demo = (globalThis as any).window;
    const post = async (url: string, body: unknown) => {
      const response = await demo.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status as number, body: await response.json() };
    };
    const snapshot = async () => (await (await demo.fetch("/api/session")).json()).snapshot;
    const move = (pane_id: string, destination: unknown) => post("/api/pane/move", { pane_id, destination });

    const a = (await post("/api/workspace/create", { cwd: "/home/demo/move-a", label: "move-a" })).body;
    const b = (await post("/api/workspace/create", { cwd: "/home/demo/move-b", label: "move-b" })).body;
    const second = (await post("/api/tab/create", { workspace_id: a.workspace_id })).body;
    const secondTab = (await snapshot()).panes.find((pane: any) => pane.pane_id === second.pane_id).tab_id;

    const intoTab = await move(second.pane_id, { type: "tab", tab_id: `${a.workspace_id}:t1` });
    assert.equal(intoTab.status, 200);
    assert.equal(intoTab.body.pane.pane_id, second.pane_id, "a move inside the workspace keeps the id");
    assert.equal(intoTab.body.closed_tab_id, secondTab, "the emptied tab closes");
    let snap = await snapshot();
    assert.deepEqual(snap.tabs.filter((tab: any) => tab.workspace_id === a.workspace_id).map((tab: any) => tab.pane_count), [2]);
    assert.equal(snap.workspaces.find((workspace: any) => workspace.workspace_id === a.workspace_id).tab_count, 1);

    const same = await move(second.pane_id, { type: "tab", tab_id: `${a.workspace_id}:t1` });
    assert.equal(same.body.changed, false);
    assert.equal(same.body.reason, "same_tab");

    const across = await move(second.pane_id, { type: "new_tab", workspace_id: b.workspace_id });
    assert.equal(across.status, 200);
    assert.notEqual(across.body.pane.pane_id, second.pane_id, "a move into another workspace gives a new id");
    assert.equal(across.body.previous_pane_id, second.pane_id);
    assert.equal(across.body.pane.workspace_id, b.workspace_id);
    assert.equal(across.body.created_tab.workspace_id, b.workspace_id);
    snap = await snapshot();
    assert.ok(!snap.panes.some((pane: any) => pane.pane_id === second.pane_id), "the old id is gone");
    assert.equal(snap.workspaces.find((workspace: any) => workspace.workspace_id === b.workspace_id).pane_count, 2);
    assert.equal(snap.workspaces.find((workspace: any) => workspace.workspace_id === a.workspace_id).pane_count, 1);

    const own = await move(across.body.pane.pane_id, { type: "new_workspace", label: "moved-out" });
    assert.equal(own.status, 200);
    assert.equal(own.body.created_workspace.label, "moved-out");
    assert.equal(own.body.pane.workspace_id, own.body.created_workspace.workspace_id);
    assert.equal(own.body.closed_tab_id, across.body.created_tab.tab_id);
    snap = await snapshot();
    assert.ok(snap.workspaces.some((workspace: any) => workspace.workspace_id === own.body.created_workspace.workspace_id));
    assert.equal(snap.workspaces.find((workspace: any) => workspace.workspace_id === b.workspace_id).tab_count, 1);

    const back = await move(own.body.pane.pane_id, { type: "new_tab", workspace_id: a.workspace_id });
    assert.equal(back.body.closed_workspace_id, own.body.created_workspace.workspace_id, "a workspace emptied by the move closes");
    assert.ok(!(await snapshot()).workspaces.some((workspace: any) => workspace.workspace_id === own.body.created_workspace.workspace_id));

    // herdr's focus on a pane that has a workspace to itself, then moved out without focus: the
    // workspace closes behind it, and the focus is left on a tab and a workspace that still exist
    const home = await post("/api/pane/move", { pane_id: back.body.pane.pane_id, destination: { type: "new_workspace", label: "focus-home" }, focus: true });
    assert.equal((await snapshot()).focused_workspace_id, home.body.created_workspace.workspace_id, "focus: true takes herdr's focus along");
    const left = await move(home.body.pane.pane_id, { type: "new_tab", workspace_id: a.workspace_id });
    assert.equal(left.body.closed_workspace_id, home.body.created_workspace.workspace_id);
    snap = await snapshot();
    const focused = snap.panes.find((pane: any) => pane.pane_id === snap.focused_pane_id);
    assert.ok(focused, "the focused pane exists");
    assert.ok(snap.tabs.some((tab: any) => tab.tab_id === snap.focused_tab_id), "the focused tab exists");
    assert.ok(snap.workspaces.some((workspace: any) => workspace.workspace_id === snap.focused_workspace_id), "the focused workspace exists");
    assert.deepEqual([focused.tab_id, focused.workspace_id], [snap.focused_tab_id, snap.focused_workspace_id], "the three focus ids name one pane");
    assert.notEqual(snap.focused_workspace_id, a.workspace_id, "a move without focus does not take the focus to the destination");

    assert.equal((await move("no-such:p1", { type: "new_tab" })).status, 404);
    assert.equal((await move(left.body.pane.pane_id, { type: "sideways" })).status, 400);
    assert.equal((await move(left.body.pane.pane_id, { type: "tab", tab_id: "no-such:t1" })).status, 404);
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as any)[key];
    }
  }
});
