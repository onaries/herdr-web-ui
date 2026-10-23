import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionSnapshot } from "../shared/protocol.ts";
import * as herdr from "./herdr/client.ts";
import { HerdrError } from "./herdr/client.ts";
import { createServer } from "./index.ts";

describe("GET /api/pane/plan", () => {
  let server: ReturnType<typeof createServer>;
  let stateDir: string;
  const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
  const error = async (response: Response) => [response.status, ((await response.json()) as { error: { code: string } }).error.code];
  const noPlan = async (response: Response) => {
    expect(response.status).toBe(200);
    const body = await response.json() as { plan: unknown; server_time: string };
    expect(body.plan).toBeNull();
    expect(Number.isFinite(Date.parse(body.server_time))).toBe(true);
  };

  beforeAll(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ovis-plan-route-"));
    server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", machines: false, sidecar: false });
  });
  afterAll(() => {
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("wants GET and a pane", async () => {
    expect(await error(await fetch(url("/api/pane/plan?pane_id=w1:p1"), { method: "POST", headers: { origin: url("") } }))).toEqual([400, "method_not_allowed"]);
    expect(await error(await fetch(url("/api/pane/plan")))).toEqual([400, "missing_pane_id"]);
  });

  it("tells a pane herdr does not have, or one that keeps no plan, that it has none", async () => {
    const snapshot = {
      workspaces: [{ workspace_id: "w1", label: "app" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main", number: 1 }],
      panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd: stateDir, agent_status: "idle" }],
    } as unknown as SessionSnapshot;
    const snap = spyOn(herdr, "sessionSnapshot").mockImplementation(async () => snapshot);
    try {
      await noPlan(await fetch(url("/api/pane/plan?pane_id=w9:p9")));
      await noPlan(await fetch(url("/api/pane/plan?pane_id=w1:p1")));
    } finally {
      snap.mockRestore();
    }
  });

  it("tells a pane it has no plan when herdr does not answer within its second", async () => {
    let answer: () => void = () => undefined;
    const snap = spyOn(herdr, "sessionSnapshot").mockImplementation(() => new Promise((_resolve, reject) => { answer = () => reject(new HerdrError("timeout", "herdr did not answer")); }));
    try {
      await noPlan(await fetch(url("/api/pane/plan?pane_id=w1:p1")));
    } finally {
      answer();
      snap.mockRestore();
    }
  });
});
