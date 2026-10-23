import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentIntegration } from "../shared/protocol.ts";
import * as herdr from "./herdr/client.ts";
import { HerdrError } from "./herdr/client.ts";
import { createServer } from "./index.ts";

describe("GET /api/integrations", () => {
  const listed: AgentIntegration[] = [
    { target: "claude", label: "Claude Code", command: "claude", available: true, state: "current" },
    { target: "antigravity_cli", label: "Antigravity", command: "agy", available: false, state: "a state from a newer herdr" },
  ];
  let server: ReturnType<typeof createServer>;
  let stateDir: string;
  const list = spyOn(herdr, "integrationList").mockImplementation(async () => listed);
  const get = (path = "/api/integrations", init?: RequestInit) => fetch(`http://127.0.0.1:${server.port}${path}`, init);
  beforeAll(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ovis-integrations-route-"));
    server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", machines: false, sidecar: false });
  });
  afterEach(() => {
    list.mockClear();
    list.mockImplementation(async () => listed);
  });
  afterAll(() => {
    server.stop();
    list.mockRestore();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("answers herdr's integration.list as it is", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ integrations: listed });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("passes herdr's own error through, and hides any other", async () => {
    list.mockImplementation(async () => { throw new HerdrError("connect_failed", "herdr is not answering"); });
    const unreachable = await get();
    expect(unreachable.status).toBe(502);
    expect(await unreachable.json()).toEqual({ error: { code: "connect_failed", message: "herdr is not answering" } });
    list.mockImplementation(async () => { throw new Error("ENOENT /home/someone/.config/herdr/socket"); });
    const broken = await get();
    expect(broken.status).toBe(500);
    const body = await broken.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).not.toContain("ENOENT");
  });

  it("refuses anything but GET without asking herdr", async () => {
    const response = await get("/api/integrations", { method: "POST", headers: { origin: `http://127.0.0.1:${server.port}` } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "method_not_allowed", message: "use GET" } });
    expect(list).not.toHaveBeenCalled();
  });
});
