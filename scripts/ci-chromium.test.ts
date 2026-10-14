import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

const script = join(import.meta.dir, "ci-chromium.sh");
const bunMock = `#!/bin/sh
printf 'bun %s\\n' "$*" >> "$MOCK_LOG"
if [ "\${1:-}" = "-e" ]; then
  if [ "\${MOCK_RESOLVER_EXIT:-0}" -ne 0 ]; then
    printf 'mock resolver failed\\n' >&2
    exit "$MOCK_RESOLVER_EXIT"
  fi
  printf '%s\\n' "$MOCK_CHROMIUM_PATH"
  exit 0
fi
case "$*" in
  *"install chromium")
    printf 'mock browser install progress\\n'
    if [ "\${MOCK_INSTALL_EXIT:-0}" -ne 0 ]; then
      printf 'mock install failed\\n' >&2
      exit "$MOCK_INSTALL_EXIT"
    fi
    exit 0;;
  *) printf 'unexpected bun invocation: %s\\n' "$*" >&2; exit 90;;
esac
`;
const sudoMock = `#!/bin/sh
printf 'sudo %s\\n' "$*" >> "$MOCK_LOG"
printf 'mock dependency install progress\\n'
exit "\${MOCK_SUDO_EXIT:-0}"
`;

interface Fixture {
  dir: string;
  bin: string;
  browser: string;
  log: string;
}

interface Result {
  stdout: string;
  stderr: string;
  code: number;
  log: string[];
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "ci-chromium-test-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const browser = join(dir, "chromium");
  const log = join(dir, "commands.log");
  writeFileSync(browser, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(bin, "bun"), bunMock, { mode: 0o755 });
  writeFileSync(join(bin, "sudo"), sudoMock, { mode: 0o755 });
  chmodSync(browser, 0o755);
  return { dir, bin, browser, log };
}

async function run(test: Fixture, extra: Record<string, string> = {}): Promise<Result> {
  const child = Bun.spawn(["bash", script], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      PATH: `${test.bin}${delimiter}${process.env.PATH ?? ""}`,
      CI: "",
      RUNNER_ENVIRONMENT: "",
      MOCK_LOG: test.log,
      MOCK_CHROMIUM_PATH: test.browser,
      ...extra,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5_000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const log = existsSync(test.log) ? readFileSync(test.log, "utf8").trim().split("\n") : [];
  return { stdout, stderr, code, log };
}

describe.skipIf(process.platform === "win32")("Chromium setup helper", () => {
  it("uses an executable preinstalled browser on self-hosted CI without installers", async () => {
    const test = fixture();
    try {
      const result = await run(test, { CI: "1", RUNNER_ENVIRONMENT: "self-hosted" });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(`${test.browser}\n`);
      expect(result.stderr).toContain("runner image");
      expect(result.log).toEqual(['bun -e console.log(require("playwright-core").chromium.executablePath())']);
    } finally {
      rmSync(test.dir, { recursive: true, force: true });
    }
  });

  it("fails stale self-hosted images with rebuild guidance and no install fallback", async () => {
    const test = fixture();
    try {
      const missing = join(test.dir, "missing-chromium");
      const result = await run(test, {
        CI: "1",
        RUNNER_ENVIRONMENT: "self-hosted",
        MOCK_CHROMIUM_PATH: missing,
      });
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Rebuild the image");
      expect(result.stderr).toContain("lockfile's Playwright version");
      expect(result.stderr).toContain("PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers");
      expect(result.log).toEqual(['bun -e console.log(require("playwright-core").chromium.executablePath())']);
    } finally {
      rmSync(test.dir, { recursive: true, force: true });
    }
  });

  it("runs bounded system dependency installation before browser install on hosted CI", async () => {
    const test = fixture();
    try {
      const result = await run(test, { CI: "1", RUNNER_ENVIRONMENT: "github-hosted" });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(`${test.browser}\n`);
      expect(result.log).toEqual([
        `sudo bash scripts/ci-bounded-retry.sh 300 ${join(test.bin, "bun")} node_modules/playwright-core/cli.js install-deps chromium`,
        "bun node_modules/playwright-core/cli.js install chromium",
        'bun -e console.log(require("playwright-core").chromium.executablePath())',
      ]);
      expect(result.stderr).toContain("mock dependency install progress");
      expect(result.stderr).toContain("mock browser install progress");
    } finally {
      rmSync(test.dir, { recursive: true, force: true });
    }
  });

  it("installs locally without sudo", async () => {
    const test = fixture();
    try {
      const result = await run(test);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(`${test.browser}\n`);
      expect(result.log).toEqual([
        "bun node_modules/playwright-core/cli.js install chromium",
        'bun -e console.log(require("playwright-core").chromium.executablePath())',
      ]);
      expect(result.stderr).toContain("mock browser install progress");
    } finally {
      rmSync(test.dir, { recursive: true, force: true });
    }
  });

  it("preserves resolver failures without printing a path", async () => {
    const test = fixture();
    try {
      const result = await run(test, { MOCK_RESOLVER_EXIT: "23" });
      expect(result.code).toBe(23);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("mock resolver failed");
      expect(result.stderr).toContain("Failed to resolve");
    } finally {
      rmSync(test.dir, { recursive: true, force: true });
    }
  });

  it("preserves browser installer failures and does not attempt resolution", async () => {
    const test = fixture();
    try {
      const result = await run(test, { MOCK_INSTALL_EXIT: "24" });
      expect(result.code).toBe(24);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("mock install failed");
      expect(result.stderr).toContain("Failed to install Chromium browser");
      expect(result.log).toEqual(["bun node_modules/playwright-core/cli.js install chromium"]);
    } finally {
      rmSync(test.dir, { recursive: true, force: true });
    }
  });

  it("preserves bounded dependency installer failures", async () => {
    const test = fixture();
    try {
      const result = await run(test, { CI: "1", RUNNER_ENVIRONMENT: "github-hosted", MOCK_SUDO_EXIT: "19" });
      expect(result.code).toBe(19);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Failed to install Chromium system dependencies");
      expect(result.log).toHaveLength(1);
      expect(result.log[0]).toContain("sudo bash scripts/ci-bounded-retry.sh 300 ");
    } finally {
      rmSync(test.dir, { recursive: true, force: true });
    }
  });
});
