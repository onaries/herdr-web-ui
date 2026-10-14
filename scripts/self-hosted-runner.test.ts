import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./self-hosted-runner/run.sh", import.meta.url));

function runRunner(options: {
  count?: number;
  ghTokenExitCode?: number;
  dockerExitCode?: number;
  failedSlot?: number;
} = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), "herdr-self-hosted-runner-test-"));
  const binDir = join(tempDir, "bin");
  const logPath = join(tempDir, "commands.log");
  const path = [binDir, process.env.PATH].filter(Boolean).join(delimiter);

  try {
    mkdirSync(binDir);
    writeFileSync(join(binDir, "gh"), `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$RUNNER_TEST_LOG"
case " $* " in
  *registration-token*)
    if [ "\${GH_TOKEN_EXIT_CODE:-0}" -ne 0 ]; then
      exit "$GH_TOKEN_EXIT_CODE"
    fi
    printf '%s\\n' mock-token
    ;;
esac
`);
    writeFileSync(join(binDir, "docker"), `#!/bin/sh
printf 'docker %s\\n' "$*" >> "$RUNNER_TEST_LOG"
case "$1" in
  image) exit 0 ;;
  run)
    IFS= read -r token || exit 1
    shift
    name=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --name ]; then
        name="$2"
        shift 2
      else
        shift
      fi
    done
    if [ "\${name##*-}" = "\${DOCKER_FAIL_SLOT:-}" ]; then
      exit "\${DOCKER_EXIT_CODE:-42}"
    fi
    exit 0
    ;;
  *) exit 0 ;;
esac
`);
    chmodSync(join(binDir, "gh"), 0o755);
    chmodSync(join(binDir, "docker"), 0o755);

    const result = spawnSync("bash", [
      script,
      "--repo",
      "owner/repo",
      "--once",
      "--count",
      String(options.count ?? 1),
    ], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: path,
        RUNNER_TEST_LOG: logPath,
        GH_TOKEN_EXIT_CODE: String(options.ghTokenExitCode ?? 0),
        DOCKER_EXIT_CODE: String(options.dockerExitCode ?? 42),
        DOCKER_FAIL_SLOT: String(options.failedSlot ?? ""),
      },
    });
    expect(result.error).toBeUndefined();
    return { result, calls: readFileSync(logPath, "utf8") };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === "win32")("self-hosted runner launcher", () => {
  it("runs without CPU or memory quotas by default", () => {
    const { result, calls } = runRunner();
    expect(result.status).toBe(0);
    const dockerRun = calls.split("\n").find((call) => call.startsWith("docker run "));
    expect(dockerRun).toBeDefined();
    expect(dockerRun).not.toContain("--cpus");
    expect(dockerRun).not.toContain("--memory");
    expect(dockerRun).toContain("--shm-size 2g");
  });

  it("propagates a one-shot Docker failure status", () => {
    const { result } = runRunner({ dockerExitCode: 42, failedSlot: 1 });
    expect(result.status).toBe(42);
  });

  it("returns failure when registration-token retrieval fails", () => {
    const { result, calls } = runRunner({ ghTokenExitCode: 1 });
    expect(result.status).toBe(1);
    expect(calls).not.toContain("docker run");
  });

  it("propagates a failed slot's status when multiple one-shot slots run", () => {
    for (const failedSlot of [1, 2]) {
      const { result } = runRunner({ count: 2, dockerExitCode: 42, failedSlot });
      expect(result.status).toBe(42);
    }
  });
});
