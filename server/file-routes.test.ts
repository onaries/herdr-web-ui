import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as herdr from "./herdr/client.ts";
import { HerdrError } from "./herdr/client.ts";
import { createServer } from "./index.ts";

describe("file routes", () => {
  let server: ReturnType<typeof createServer>;
  let stateDir: string;
  let folder: string;
  let notes: string;
  const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
  const q = (value: string) => encodeURIComponent(value);
  const error = async (response: Response) => [response.status, ((await response.json()) as { error: { code: string } }).error.code];

  beforeAll(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ovis-file-routes-"));
    folder = join(stateDir, "project");
    mkdirSync(join(folder, "public"), { recursive: true });
    mkdirSync(join(folder, "docs"));
    notes = join(folder, "notes.txt");
    writeFileSync(notes, "hello");
    writeFileSync(join(folder, "public", "favicon.ico"), new Uint8Array([0, 0, 1, 0, 1, 0, 16, 16]));
    server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", machines: false, sidecar: false });
  });
  afterAll(() => {
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("wants GET or HEAD, and no other site's page", async () => {
    expect(await error(await fetch(url(`/api/fs/stat?path=${q(notes)}`), { method: "POST", headers: { origin: url("") } }))).toEqual([400, "method_not_allowed"]);
    expect(await error(await fetch(url(`/api/fs/file?path=${q(notes)}`), { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" } }))).toEqual([403, "cross_site"]);
    expect((await fetch(url(`/api/fs/file?path=${q(notes)}`), { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" } })).status).toBe(200);
    expect((await fetch(url(`/api/fs/file?path=${q(notes)}`), { method: "HEAD" })).status).toBe(200);
  });

  it("describes and serves a file by its absolute path, and says when there is none", async () => {
    const stat = await fetch(url(`/api/fs/stat?path=${q(notes)}`));
    expect(stat.status).toBe(200);
    expect(await stat.json()).toMatchObject({ name: "notes.txt", kind: "text", size: 5 });
    const file = await fetch(url(`/api/fs/file?path=${q(notes)}`));
    expect(await file.text()).toBe("hello");
    expect(file.headers.get("content-disposition")).toStartWith("inline;");
    expect((await fetch(url(`/api/fs/file?path=${q(notes)}&download=1`))).headers.get("content-disposition")).toStartWith("attachment;");
    expect(await error(await fetch(url(`/api/fs/stat?path=${q(join(folder, "missing.txt"))}`)))).toEqual([404, "not_found"]);
  });

  it("finds a relative path in the named pane's folder, and none when herdr cannot say it", async () => {
    const get = spyOn(herdr, "paneGet").mockImplementation(async (paneId) => ({ pane_id: paneId, workspace_id: "w1", tab_id: "w1:t1", cwd: folder, agent_status: "idle" }) as unknown as Awaited<ReturnType<typeof herdr.paneGet>>);
    try {
      const found = await fetch(url("/api/fs/stat?pane_id=w1:p1&path=notes.txt"));
      expect(found.status).toBe(200);
      expect(await found.json()).toMatchObject({ name: "notes.txt", size: 5 });
      get.mockImplementation(async (paneId) => { throw new HerdrError("pane_not_found", `pane ${paneId} not found`); });
      expect(await error(await fetch(url("/api/fs/stat?pane_id=w1:p1&path=notes.txt")))).toEqual([404, "not_found"]);
      expect((await fetch(url(`/api/fs/stat?pane_id=w1:p1&path=${q(notes)}`))).status).toBe(200);
    } finally {
      get.mockRestore();
    }
  });

  it("answers a folder's project icon, or none", async () => {
    expect(await error(await fetch(url("/api/fs/favicon")))).toEqual([400, "missing_root"]);
    expect(await (await fetch(url(`/api/fs/favicon?root=${q(folder)}`))).json()).toMatchObject({ icon: { name: "favicon.ico", kind: "image" } });
    expect(await (await fetch(url(`/api/fs/favicon?root=${q(join(folder, "docs"))}`))).json()).toEqual({ icon: null });
  });

  it("plays no page media it never gave out", async () => {
    expect(await error(await fetch(url("/api/fs/page-media/not-a-token")))).toEqual([404, "not_found"]);
    expect(await error(await fetch(url("/api/fs/page-media/not-a-token"), { method: "POST", headers: { origin: url("") } }))).toEqual([400, "method_not_allowed"]);
  });
});
