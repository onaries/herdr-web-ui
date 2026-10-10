import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Machine } from "../shared/machines.ts";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { CompletionTracker } from "./completion.ts";
import { sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { MachineManager } from "./machines.ts";
import { createPushService } from "./push.ts";

describe("slow structural roster refreshes", () => {
  for (const remote of [false, true]) {
    it(`publishes each slow ${remote ? "remote" : "local"} roster while structural changes continue`, async () => {
      const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-test-slow-roster-"));
      const workspace = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-slow-roster" });
      let manager: MachineManager | undefined;
      let bridge: ReturnType<typeof Bun.serve> | undefined;
      let pending: { snapshot: SessionSnapshot; resolve: (snapshot: SessionSnapshot) => void } | undefined;
      let started = Promise.withResolvers<void>();
      let held = false;
      const read = async (): Promise<SessionSnapshot> => {
        const snapshot = await sessionSnapshot();
        if (!held) return snapshot;
        return new Promise((resolve) => { pending = { snapshot, resolve }; started.resolve(); });
      };
      try {
        const ready = Promise.withResolvers<void>();
        manager = new MachineManager(root, createPushService({ stateDir: root }), new CompletionTracker(null), remote ? sessionSnapshot : read);
        const unsubscribe = manager.subscribe((event) => {
          if (event.type === "machines" && event.machines[0]?.state === "connected") ready.resolve();
        });
        await ready.promise;
        unsubscribe();
        type TestRuntime = { machine: Machine; endpoint?: { url: string; token: string }; ssh?: { close(): void; onExit?: () => void } };
        const drive = manager as unknown as {
          machines: Map<string, TestRuntime>;
          runtime(machine: Machine): TestRuntime;
          refresh(runtime: TestRuntime): Promise<void>;
          observe(runtime: TestRuntime): Promise<void>;
        };
        const runtime = drive.runtime({ id: "remote", name: "Slow fixture", kind: "ssh", enabled: true, state: "connected", error: null, snapshot: null });
        let observer: { send(data: string): unknown } | undefined;
        if (remote) {
          const observing = Promise.withResolvers<void>();
          bridge = Bun.serve({
            port: 0, hostname: "127.0.0.1",
            async fetch(request, server) {
              if (new URL(request.url).pathname === "/ws" && server.upgrade(request, { data: undefined })) return;
              return Response.json({ snapshot: await read() });
            },
            websocket: {
              open(ws) { observer = ws; },
              message(_ws, data) { if (JSON.parse(String(data)).type === "role") observing.resolve(); },
            },
          });
          runtime.endpoint = { url: `http://127.0.0.1:${bridge.port}`, token: "fixture" };
          runtime.ssh = { close() {} };
          drive.machines.set("remote", runtime);
          await drive.observe(runtime);
          await observing.promise;
        }
        held = true;
        const loading = remote ? drive.refresh(runtime) : manager.refreshLocal();
        for (let pass = 0; pass < 4; pass++) {
          await started.promise;
          const response = pending;
          if (!response) throw new Error("held roster missing");
          pending = undefined;
          started = Promise.withResolvers<void>();
          let publishedRoster = false;
          const stopListening = manager.subscribe((event) => {
            if (event.type !== "machines") return;
            const snapshot = remote ? runtime.machine.snapshot : event.machines[0]?.snapshot;
            if (snapshot?.workspaces.some((item) => item.workspace_id === workspace.workspace.workspace_id)) publishedRoster = true;
          });
          // subscribe() sends the current roster synchronously; only the held load counts.
          publishedRoster = false;
          // Structural invalidations only queue another read; they must not obsolete this one.
          if (remote) {
            const invalidated = Promise.withResolvers<void>();
            const stopWaiting = manager.subscribe((event) => {
              if (event.type === "machine-message" && event.machine_id === "remote" && event.message.type === "session-changed") invalidated.resolve();
            });
            if (!observer) throw new Error("remote observer missing");
            observer.send(JSON.stringify({ type: "session-changed" }));
            await invalidated.promise;
            stopWaiting();
          } else manager.localMessage({ type: "session-changed" });
          const nextRead = started.promise;
          response.resolve(response.snapshot);
          // The next read starts whether or not the previous response was published.
          await nextRead;
          stopListening();
          expect(publishedRoster).toBe(true);
        }
        held = false;
        if (!pending) throw new Error("follow-up roster missing");
        pending.resolve(pending.snapshot);
        await loading;
      } finally {
        manager?.stop();
        if (pending) pending.resolve(pending.snapshot);
        bridge?.stop(true);
        await workspaceClose(workspace.workspace.workspace_id);
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
