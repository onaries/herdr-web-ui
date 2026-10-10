import assert from "node:assert/strict";
import { it } from "bun:test";

/** herdr moves an automatic tab name up when an earlier tab closes; a renamed tab keeps its name. */
it("the demo relabels automatic tab names by place and leaves custom numeric names alone", async () => {
  const saved = new Map(["window", "location", "PushManager"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    const storage = new Map<string, string>();
    (globalThis as any).location = new URL("http://demo.test/demo/app/");
    (globalThis as any).window = {
      fetch, WebSocket, EventSource: class {},
      localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    };
    const transport = "../site/demo/transport.ts?tabs";
    await import(transport);
    const demo = (globalThis as any).window;
    const post = async (url: string, body: unknown) => (await demo.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
    const labels = async (workspaceId: string) =>
      (await (await demo.fetch("/api/session")).json()).snapshot.tabs.filter((tab: any) => tab.workspace_id === workspaceId).map((tab: any) => `${tab.tab_id.split(":")[1]}=${tab.label}`);

    const made = await post("/api/workspace/create", { cwd: "/home/demo/tabs-check", label: "tabs-check" });
    const workspace = made.workspace_id as string;
    for (let i = 0; i < 3; i += 1) await post("/api/tab/create", { workspace_id: workspace });
    assert.deepEqual(await labels(workspace), ["t1=tabs-check", "t2=2", "t3=3", "t4=4"]);

    await post("/api/tab/close", { tab_id: `${workspace}:t1` });
    assert.deepEqual(await labels(workspace), ["t2=1", "t3=2", "t4=3"]);

    // an explicit numeric name is a name: it survives the tab before it closing
    await post("/api/tab/rename", { tab_id: `${workspace}:t4`, label: "3" });
    await post("/api/tab/close", { tab_id: `${workspace}:t2` });
    assert.deepEqual(await labels(workspace), ["t3=1", "t4=3"]);

    // a tab closed through its last pane is forgotten: a named tab made afterwards keeps its name
    await post("/api/tab/create", { workspace_id: workspace });
    const after = (await (await demo.fetch("/api/session")).json()).snapshot;
    const unnamed = after.tabs.filter((tab: any) => tab.workspace_id === workspace).at(-1).tab_id as string;
    const pane = after.panes.find((candidate: any) => candidate.tab_id === unnamed);
    await post("/api/pane/close", { pane_id: pane.pane_id });
    await post("/api/tab/create", { workspace_id: workspace, label: "build" });
    assert.deepEqual((await labels(workspace)).map((entry: string) => entry.split("=")[1]), ["1", "3", "build"]);
    const beforeMove = (await (await demo.fetch("/api/session")).json()).snapshot;
    const ordered = beforeMove.tabs.filter((tab: any) => tab.workspace_id === workspace);
    const moved = await post("/api/tab/move", { tab_id: ordered[0].tab_id, insert_index: 3 });
    assert.deepEqual(moved.tabs.map((tab: any) => tab.tab_id), [ordered[1].tab_id, ordered[2].tab_id, ordered[0].tab_id]);
    assert.deepEqual((await labels(workspace)).map((entry: string) => entry.split("=")[1]), ["3", "build", "3"]);
    const afterMove = (await (await demo.fetch("/api/session")).json()).snapshot;
    assert.equal(afterMove.focused_pane_id, beforeMove.focused_pane_id);
    assert.equal(afterMove.focused_tab_id, beforeMove.focused_tab_id);
    const invalid = await demo.fetch("/api/tab/move", { method: "POST", body: JSON.stringify({ tab_id: ordered[0].tab_id, insert_index: -1 }) });
    assert.equal(invalid.status, 400);
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as any)[key];
    }
  }
});
