import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "../shared/protocol.ts";
import { startStatusCollector } from "./collector.ts";
import { createServer } from "./index.ts";
import { herdrRpc, sessionSnapshot, subscribeEvents, workspaceClose, workspaceCreate } from "./herdr/client.ts";

describe("socket lifecycle changes reach WebSocket clients", () => {
  let app: ReturnType<typeof createServer>;
  let workspace: Awaited<ReturnType<typeof workspaceCreate>>;
  let ws: WebSocket;
  let movedWorkspace: string | undefined;
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-web-ui-collector-contract-"));

  function nextFrame(type: string, matches: (frame: ServerMessage) => boolean = () => true, timeoutMs = 1000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.removeEventListener("message", onMessage);
        reject(new Error(`No matching ${type} frame within ${timeoutMs} ms`));
      }, timeoutMs);
      function onMessage(event: MessageEvent) {
        const frame = JSON.parse(String(event.data));
        if (frame.type !== type || !matches(frame)) return;
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        resolve();
      }
      ws.addEventListener("message", onMessage);
    });
  }

  beforeAll(async () => {
    workspace = await workspaceCreate({ cwd: stateDir, label: "herdr-web-ui-test-collector-lifecycle" });
    // A single-pane zoom can only change focus, not the layout. Split before
    // starting the app so its lifecycle frame cannot satisfy the zoom matcher.
    await herdrRpc("pane.split", { target_pane_id: workspace.root_pane.pane_id, direction: "right", cwd: stateDir, focus: false });
    app = createServer({ port: 0, stateDir });
    await app.statusReady;
    ws = new WebSocket(`ws://localhost:${app.port}/ws`);
    await nextFrame("snapshot");
  });

  afterAll(async () => {
    ws?.close();
    app?.stop();
    if (movedWorkspace) await workspaceClose(movedWorkspace);
    if (workspace) await workspaceClose(workspace.workspace.workspace_id);
    rmSync(stateDir, { recursive: true, force: true });
  });

  for (const method of ["workspace.rename", "tab.rename", "pane.zoom"]) {
    it(`pushes session-changed within one second after ${method} over the socket`, async () => {
      const params = method === "workspace.rename"
        ? { workspace_id: workspace.workspace.workspace_id, label: "collector-renamed-workspace" }
        : method === "tab.rename"
          ? { tab_id: workspace.tab.tab_id, label: "collector-renamed-tab" }
          : { pane_id: workspace.root_pane.pane_id, mode: "on" };
      const changed = nextFrame("session-changed");
      const started = performance.now();
      const result = await herdrRpc(method, params);
      if (method === "pane.zoom") expect(result).toMatchObject({ zoom: { changed: true, zoom_changed: true } });
      await changed;
      expect(performance.now() - started).toBeLessThan(1000);
      if (method === "pane.zoom") {
        const restored = nextFrame("session-changed");
        await herdrRpc("pane.zoom", { pane_id: workspace.root_pane.pane_id, mode: "off" });
        await restored;
      }
    });
  }

  it("tells browsers of a completion after a working pane moves before reconciliation", async () => {
    const working = nextFrame("pane-status", (frame) => frame.type === "pane-status" && frame.pane_id === workspace.root_pane.pane_id && frame.agent_status === "working");
    await herdrRpc("pane.report_agent", { pane_id: workspace.root_pane.pane_id, source: "manual", agent: "codex", state: "working" });
    await working;
    const { move_result } = await herdrRpc<{ move_result: { changed: boolean; pane: { pane_id: string; workspace_id: string } } }>("pane.move", {
      pane_id: workspace.root_pane.pane_id, destination: { type: "new_workspace", label: "herdr-web-ui-test-moved-completion" }, focus: false,
    });
    expect(move_result.changed).toBe(true);
    expect(move_result.pane.pane_id).not.toBe(workspace.root_pane.pane_id);
    movedWorkspace = move_result.pane.workspace_id;
    const completed = nextFrame("pane-status", (frame) => frame.type === "pane-status" && frame.pane_id === move_result.pane.pane_id && frame.agent_status === "done", 2000);
    await herdrRpc("pane.report_agent", { pane_id: move_result.pane.pane_id, source: "manual", agent: "codex", state: "idle" });
    await completed;
  });
});

describe("completion replay across a moved subscription key", () => {
  it("replays the finish when a working move overtakes a queued old-ID status event", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-test-moved-gap-"));
    const workspace = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-moved-gap" });
    let workspaceId = workspace.workspace.workspace_id;
    const statuses: { paneId: string; before: string | undefined }[] = [];
    await herdrRpc("pane.report_agent", { pane_id: workspace.root_pane.pane_id, source: "manual", agent: "codex", state: "idle" });
    const queued = Promise.withResolvers<void>();
    const moved = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    let moving = false;
    let delayedWorking: (() => void) | undefined;
    let reconciled = Promise.withResolvers<void>();
    const collector = startStatusCollector({
      onStatus(paneId, status, _agent, replay) {
        statuses.push({ paneId, before: replay?.before });
      },
      onBaseline() {},
      onPaneEnded() {},
      onStructureChange() {},
      onReconciled(panes) {
        if (panes.some((pane) => pane.workspace_id === workspaceId && pane.agent_status !== "working")) reconciled.resolve();
      },
    }, {
      async snapshot() {
        // No timing luck: reconciliation can read the moved pane only after
        // it finishes, even if the machine stalls beyond the debounce.
        if (moving) await finished.promise;
        return sessionSnapshot();
      },
      subscribe(subs, handlers, ...rest) {
        const subscribedIds = new Set(subs.flatMap((sub) => "pane_id" in sub ? [sub.pane_id] : []));
        return subscribeEvents(subs, {
          ...handlers,
          onEvent(frame) {
            const data = frame.data as { type?: string; pane_id?: string; agent_status?: string };
            if (frame.event === "pane.agent_status_changed" && data.pane_id === workspace.root_pane.pane_id && data.agent_status === "working") {
              // Hold the old connection's event until the lifecycle connection
              // has delivered the move, preserving the real frame and callbacks.
              delayedWorking = () => handlers.onEvent(frame);
              queued.resolve();
              return;
            }
            // Model the known move gap: a stream opened for the old ID gives no
            // guarantee of delivery for the new ID until the collector reopens it.
            if (frame.event === "pane.agent_status_changed") {
              const data = frame.data as { pane_id: string };
              if (!subscribedIds.has(data.pane_id)) return;
            }
            handlers.onEvent(frame);
            if (data.type === "pane_moved") {
              delayedWorking?.();
              moved.resolve();
            }
          },
        }, ...rest);
      },
    });
    try {
      await collector.ready;
      await herdrRpc("pane.report_agent", { pane_id: workspace.root_pane.pane_id, source: "manual", agent: "codex", state: "working" });
      await queued.promise;
      expect(statuses).toEqual([]);
      moving = true;
      const { move_result } = await herdrRpc<{ move_result: { pane: { pane_id: string; workspace_id: string } } }>("pane.move", {
        pane_id: workspace.root_pane.pane_id, destination: { type: "new_workspace", label: "herdr-web-ui-test-moved-gap" }, focus: false,
      });
      workspaceId = move_result.pane.workspace_id;
      await moved.promise;
      expect(statuses).toEqual([{ paneId: workspace.root_pane.pane_id, before: undefined }]);
      statuses.length = 0;
      reconciled = Promise.withResolvers<void>();
      await herdrRpc("pane.report_agent", { pane_id: move_result.pane.pane_id, source: "manual", agent: "codex", state: "idle" });
      finished.resolve();
      await reconciled.promise;
      expect(statuses).toEqual([{ paneId: move_result.pane.pane_id, before: "working" }]);
    } finally {
      finished.resolve();
      collector.stop();
      await workspaceClose(workspaceId);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
