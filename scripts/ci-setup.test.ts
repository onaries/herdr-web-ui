import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const action = Bun.YAML.parse(readFileSync(join(root, ".github/actions/setup-ci/action.yml"), "utf8")) as {
  inputs: Record<string, { default: string }>;
  runs: { steps: Array<{ name?: string; uses?: string; if?: string; with?: Record<string, string>; env?: Record<string, string> }> };
};

function prepared(overrides: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ci-preinstalled-"));
  const calls = join(dir, "calls");
  try {
    for (const name of ["bun", "node", "herdr", "sha256sum"]) {
      writeFileSync(join(dir, name), `#!/bin/sh
printf '%s\\n' '${name}' >> "$TEST_CALLS"
case '${name}' in
  bun) printf '%s\\n' "$TEST_BUN" ;;
  node) printf '%s\\n' "$TEST_NODE" ;;
  sha256sum) IFS= read -r line; exit "$TEST_CHECKSUM_EXIT" ;;
esac
`, { mode: 0o755 });
    }
    const result = spawnSync("bash", [join(root, "scripts/ci-preinstalled-tools.sh")], {
      encoding: "utf8", timeout: 5_000,
      env: {
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
        EXPECTED_BUN_VERSION: action.inputs["bun-version"]!.default,
        NEED_NODE: "true", NEED_HERDR: "true",
        TEST_BUN: action.inputs["bun-version"]!.default, TEST_NODE: "v22.23.3",
        TEST_CHECKSUM_EXIT: "0", TEST_CALLS: calls, ...overrides,
      },
    });
    expect(result.error).toBeUndefined();
    return { ...result, calls: result.status === 0 ? readFileSync(calls, "utf8") : "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === "win32")("prepared CI tools", () => {
  it("checks the requested tools without downloading replacements", () => {
    const result = prepared();
    expect(result.status).toBe(0);
    expect(result.calls.trim().split("\n")).toEqual(["bun", "node", "sha256sum"]);
  });

  it("does not require optional tools for Bun-only jobs", () => {
    const result = prepared({ NEED_NODE: "false", NEED_HERDR: "false", TEST_NODE: "v18.0.0", TEST_CHECKSUM_EXIT: "1" });
    expect(result.status).toBe(0);
    expect(result.calls.trim()).toBe("bun");
  });

  for (const [name, env] of [
    ["stale Bun", { TEST_BUN: "1.0.0" }],
    ["wrong Node major", { TEST_NODE: "v24.0.0" }],
    ["untrusted herdr binary", { TEST_CHECKSUM_EXIT: "1" }],
    ["unsupported architecture", { RUNNER_ARCH: "ARM64" }],
    ["unsupported host OS", { RUNNER_OS: "Windows" }],
  ] as const) {
    it(`fails closed for ${name}`, () => {
      const result = prepared(env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Rebuild scripts/self-hosted-runner/Dockerfile");
    });
  }
});

describe("CI cache contract", () => {
  it("keeps the prepared image aligned with the workflow and lockfile", () => {
    const dockerfile = readFileSync(join(root, "scripts/self-hosted-runner/Dockerfile"), "utf8");
    const lockfile = readFileSync(join(root, "bun.lock"), "utf8");
    expect(dockerfile.match(/^ARG BUN_VERSION=(.+)$/m)?.[1]).toBe(action.inputs["bun-version"]!.default);
    const playwright = lockfile.match(/"playwright-core": \["playwright-core@([^"]+)"/)?.[1];
    expect(playwright).toBeDefined();
    expect(dockerfile.match(/^ARG PLAYWRIGHT_VERSION=(.+)$/m)?.[1]).toBe(playwright);
  });

  it("saves the dependency cache only when a job allows it", () => {
    const save = action.runs.steps.find((step) => step.name === "Cache Bun dependencies")!;
    const restore = action.runs.steps.find((step) => step.name === "Restore Bun dependencies (read-only)")!;
    expect(action.inputs.cache!.default).toBe("save");
    expect(save.if).toContain("inputs.cache != 'restore'");
    expect(restore.if).toContain("inputs.cache == 'restore'");
    expect(restore.uses).toBe("actions/cache/restore@v4");
    expect(restore.with).toEqual(save.with);
    const canary = Bun.YAML.parse(readFileSync(join(root, ".github/workflows/omp-question-compat.yml"), "utf8")) as {
      jobs: Record<string, { steps: Array<{ uses?: string; with?: Record<string, string> }> }>;
    };
    for (const job of Object.values(canary.jobs)) {
      expect(job.steps.find((step) => step.uses === "./.github/actions/setup-ci")!.with!.cache).toBe("restore");
    }
  });

  it("keeps dependency caches inside the workspace and separates runner environments", () => {
    const cache = action.runs.steps.find((step) => step.name === "Cache Bun dependencies")!;
    expect(cache.with!.path).toBe(".ci-cache/bun");
    expect(cache.with!.key).toContain("bun-workspace-v2-${{ runner.environment }}-");
    expect(cache.with!["restore-keys"]).toStartWith("bun-workspace-v2-${{ runner.environment }}-");
    const directory = action.runs.steps.find((step) => step.name === "Select workspace-local Bun cache")!;
    expect(directory.env!.BUN_CACHE_DIR).toBe(`\${{ github.workspace }}/${cache.with!.path}`);
  });

  it("does not transfer dependency or browser caches over the prepared image", () => {
    for (const name of ["Cache Bun dependencies", "Restore Bun dependencies (read-only)"]) {
      expect(action.runs.steps.find((step) => step.name === name)!.if).toStartWith("runner.environment != 'self-hosted' && ");
    }
    for (const uses of ["oven-sh/setup-bun@v2", "actions/setup-node@v7"]) {
      expect(action.runs.steps.find((step) => step.uses === uses)!.if).toContain("runner.environment != 'self-hosted'");
    }
    expect(action.runs.steps.find((step) => step.name === "Install checksum-pinned herdr 0.9.3")!.if)
      .toContain("runner.environment != 'self-hosted'");
    const workflow = Bun.YAML.parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")) as {
      jobs: Record<string, { steps: Array<{ name?: string; if?: string; with?: Record<string, string> }> }>;
    };
    for (const job of ["browser-main", "browser-other"]) {
      const cache = workflow.jobs[job]!.steps.find((step) => step.name === "Cache Playwright browser")!;
      expect(cache.if).toContain("runner.environment != 'self-hosted'");
      expect(cache.with!.path).toBe(".ci-cache/playwright");
      expect(cache.with!.key).toStartWith("playwright-workspace-v2-");
    }
  });

  it.skipIf(process.platform === "win32")("restores dependency cache contents across different checkout depths", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-cache-layout-"));
    try {
      const hosted = join(dir, "home/runner/work/repo/repo");
      const selfHosted = join(dir, "w/repo/repo");
      const path = action.runs.steps.find((step) => step.name === "Cache Bun dependencies")!.with!.path!;
      mkdirSync(join(hosted, path), { recursive: true });
      mkdirSync(selfHosted, { recursive: true });
      writeFileSync(join(hosted, path, "dependency"), "cached bytes");
      const archive = join(dir, "cache.tgz");
      const pack = spawnSync("tar", ["-czf", archive, "-C", hosted, path], { timeout: 5_000 });
      expect(pack.status).toBe(0);
      const unpack = spawnSync("tar", ["-xzf", archive, "-C", selfHosted], { timeout: 5_000 });
      expect(unpack.status).toBe(0);
      expect(readFileSync(join(selfHosted, path, "dependency"), "utf8")).toBe("cached bytes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
