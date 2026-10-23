import { describe, expect, it } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./self-hosted-runner/run.sh", import.meta.url));
const jobStarted = fileURLToPath(new URL("./self-hosted-runner/job-started.sh", import.meta.url));

/** Runs the hook as the runner does, under a process named Runner.Worker (a copy of bash) that goes on after it. */
function runJobStarted(eventName: string, payload: unknown, event: { raw?: string; path?: "missing" | "directory" | "unset"; repository?: "unset"; closedOutput?: boolean } = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), "herdr-runner-hook-test-"));
  try {
    let eventPath: string | undefined = join(tempDir, "event.json");
    writeFileSync(eventPath, event.raw ?? JSON.stringify(payload));
    if (event.path === "missing") eventPath = join(tempDir, "no-such-event.json");
    if (event.path === "directory") eventPath = tempDir;
    if (event.path === "unset") eventPath = undefined;
    const worker = join(tempDir, "Runner.Worker");
    copyFileSync(spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim(), worker);
    chmodSync(worker, 0o755);
    // closedOutput: the hook's stdout and stderr are a pipe nobody reads any more (a FIFO whose only
    // reader is closed before the hook starts), so its first write, even an error message, raises SIGPIPE
    const hook = event.closedOutput
      ? 'mkfifo "$1" && exec 4<>"$1" 5>"$1" 4<&- && bash "$0" >&5 2>&5; echo "next step ran"'
      : 'bash "$0"; echo "next step ran"';
    const result = spawnSync(worker, ["-c", hook, jobStarted, join(tempDir, "output.fifo")], {
      encoding: "utf8",
      timeout: 5_000,
      env: {
        PATH: process.env.PATH ?? "",
        GITHUB_EVENT_NAME: eventName,
        ...(event.repository === "unset" ? {} : { GITHUB_REPOSITORY: "devswha/ovis" }),
        ...(eventPath === undefined ? {} : { GITHUB_EVENT_PATH: eventPath }),
      },
    });
    expect(result.error).toBeUndefined();
    return result;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

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
    # the shared network namespace container is detached and reads no token
    [ "$2" = -d ] && exit 0
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

/** A runner container: it reads its registration token on stdin. */
const runnerRun = /^docker run --rm -i /;

describe.skipIf(process.platform === "win32")("self-hosted runner launcher", () => {
  it("runs without CPU or memory quotas by default", () => {
    const { result, calls } = runRunner();
    expect(result.status).toBe(0);
    const dockerRun = calls.split("\n").find((call) => runnerRun.test(call));
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
    expect(calls.split("\n").filter((call) => runnerRun.test(call))).toEqual([]);
  });

  it("starts every runner in one shared network namespace, never the host's, and stops it last", () => {
    const { result, calls } = runRunner({ count: 2 });
    expect(result.status).toBe(0);
    const lines = calls.split("\n");
    const namespace = lines.findIndex((call) => /^docker run -d .*--entrypoint sleep .* infinity$/.test(call));
    expect(namespace).toBeGreaterThanOrEqual(0);
    const name = lines[namespace]!.match(/--name (\S+)/)![1]!;
    expect(name).toMatch(/^herdr-ci-.+-net$/);
    expect(lines[namespace]).toContain("--cap-drop ALL");
    expect(lines[namespace]).not.toContain("--network");
    const runners = lines.map((call, index) => ({ call, index })).filter(({ call }) => runnerRun.test(call));
    expect(runners).toHaveLength(2);
    for (const { call, index } of runners) {
      expect(index).toBeGreaterThan(namespace);
      expect(call).toContain(`--network container:${name}`);
      expect(call).not.toContain("--network host");
    }
    const stopped = lines.findIndex((call) => call.startsWith(`docker stop`) && call.endsWith(` ${name}`));
    expect(stopped).toBeGreaterThan(Math.max(...lines.map((call, index) => (call.startsWith("docker stop") && !call.endsWith(` ${name}`) ? index : -1))));
  });

  it("propagates a failed slot's status when multiple one-shot slots run", () => {
    for (const failedSlot of [1, 2]) {
      const { result } = runRunner({ count: 2, dockerExitCode: 42, failedSlot });
      expect(result.status).toBe(42);
    }
  });
});

// the runner image is Linux, and the hook finds the worker through /proc
describe.skipIf(process.platform !== "linux")("self-hosted runner job-started hook", () => {
  it("runs a job from this repository", () => {
    for (const [event, payload] of [
      ["push", { ref: "refs/heads/main" }],
      ["pull_request", { pull_request: { head: { repo: { full_name: "devswha/ovis" } } } }],
      ["workflow_run", { workflow_run: { head_repository: { full_name: "devswha/ovis" } } }],
    ] as const) {
      const result = runJobStarted(event, payload);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("next step ran");
    }
  });

  it("refuses a job carrying another repository's code before it runs", () => {
    for (const [event, payload] of [
      ["pull_request", { pull_request: { head: { repo: { full_name: "someone/ovis" } } } }],
      ["pull_request_target", { pull_request: { head: { repo: { full_name: "someone/ovis" } } } }],
      ["pull_request", { pull_request: { head: { repo: null } } }],
      ["workflow_run", { workflow_run: { head_repository: { full_name: "someone/ovis" } } }],
    ] as const) {
      const result = runJobStarted(event, payload);
      // a failing hook alone would let `if: always()` steps run: the worker itself is killed
      expect(result.signal).toBe("SIGKILL");
      expect(result.stdout).toContain("::error::");
      expect(result.stdout).not.toContain("next step ran");
    }
  });

  it("refuses a job it cannot check: fails closed on an unreadable or broken event", () => {
    const forkless = { ref: "refs/heads/main" };
    for (const event of [
      { path: "missing" },
      { path: "directory" },
      { path: "unset" },
      { raw: '{"pull_request": {"head":' },
      { raw: "not json" },
      { raw: '{"pull_request": "someone/ovis"}' },
      { repository: "unset" },
      { path: "missing", closedOutput: true },
      // the shell's own `${VAR:?}` message on a closed stderr
      { path: "unset", closedOutput: true },
      { repository: "unset", closedOutput: true },
    ] as const) {
      const result = runJobStarted("push", forkless, event);
      expect(result.signal).toBe("SIGKILL");
      // a closed output takes the refusal with it: the kill alone is the evidence there
      if (!("closedOutput" in event)) expect(result.stdout).toContain("::error::");
      expect(result.stdout).not.toContain("next step ran");
    }
  });
});
