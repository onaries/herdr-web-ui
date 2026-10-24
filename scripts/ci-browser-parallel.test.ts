import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failureSite } from "./ci-browser-parallel.ts";

describe("parallel browser output timestamps", () => {
  it("timestamps script log lines without changing status output or summary JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "browser-parallel-test-"));
    const bin = join(dir, "bin");
    const logs = join(dir, "browser-logs");
    mkdirSync(bin);
    writeFileSync(join(bin, "bash"), '#!/bin/sh\nprintf "/stub/chrome\\\\n"\n', { mode: 0o755 });
    writeFileSync(join(bin, "bun"), '#!/bin/sh\nif [ "$1" = scripts/demo-build.ts ]; then exit 0; fi\nprintf "PASS stubbed browser step\\\\nFAIL stubbed failure marker\\\\nSERVER listening on 127.0.0.1:4321"\n', { mode: 0o755 });
    try {
      const child = Bun.spawn([process.execPath, "scripts/ci-browser-parallel.ts"], {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          BROWSER_SCRIPTS: "scripts/ui-regression.ts",
          BROWSER_RETRY: "0",
          CHECK_DIR: dir,
        },
        stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000,
      });
      const [text, error, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(error).toBe("");
      expect(code).toBe(0);
      expect(text).toContain("[worker-0] PASS scripts/ui-regression.ts");
      const log = readFileSync(join(logs, "ui-regression.log"), "utf8");
      expect(log).toMatch(/^\[\d{4}-\d\d-\d\dT[^\]]+\] PASS stubbed browser step$/m);
      expect(log).toMatch(/^\[\d{4}-\d\d-\d\dT[^\]]+\] FAIL stubbed failure marker$/m);
      expect(log).toMatch(/^\[\d{4}-\d\d-\d\dT[^\]]+\] SERVER listening on 127\.0\.0\.1:4321$/m);
      expect(failureSite(`${log}[2026-10-23T00:00:00.000Z] AssertionError: stub failure\n[2026-10-23T00:00:00.000Z]     at run (/repo/scripts/ui-regression.ts:1:1)`)).toEqual({
        site: "scripts/ui-regression.ts:1",
        message: "AssertionError: stub failure",
      });
      expect(text).toContain("Total: 1/1 passed");
      const summary = readFileSync(join(logs, "summary.json"), "utf8");
      expect(summary).toContain('"workers": 1');
      expect(summary).toContain('"passed": 1');
      expect(summary).toContain('"total": 1');
      expect(summary).toContain('"flaky": []');
      expect(summary).toContain('"script": "scripts/ui-regression.ts"');
      expect(summary).toContain('"code": 0');
      expect(summary).not.toContain("timestamp");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
