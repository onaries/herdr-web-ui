import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gjcSdkTranscriptWithRunner as sdkTranscriptWithRunner,
  type GjcSdkCommandOptions,
  type GjcSdkCommandRunner,
  type GjcSdkWorktreeRootResolver,
} from "./gjc-sdk.ts";

const cwd = mkdtempSync(join(tmpdir(), "gjc-sdk-test-"));
const agentDir = join(cwd, "agent");
const savedPath = join(cwd, "sessions", "session.jsonl");
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

const locator = () => ({ cwd, worktreeRoot: cwd, stateRoot: join(cwd, ".gjc", "state") });

const testWorktreeRootResolver: GjcSdkWorktreeRootResolver = async () => cwd;

function gjcSdkTranscriptWithRunner(
  pids: readonly number[],
  workingDirectory: string,
  directory: string,
  runner: GjcSdkCommandRunner,
  rootResolver: GjcSdkWorktreeRootResolver = testWorktreeRootResolver,
) {
  return sdkTranscriptWithRunner(pids, workingDirectory, directory, runner, rootResolver);
}

function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: "session-1",
    locator: locator(),
    endpointGeneration: 4,
    pid: 321,
    hostIncarnation: "linux:12345",
    identityProvenance: "composite",
    terminalUncertain: false,
    ambiguous: false,
    terminal: false,
    live: true,
    ...overrides,
  };
}

function broker(result: Record<string, unknown>): string {
  return JSON.stringify({ type: "broker_response", ok: true, result });
}

function page(sessions: unknown[], extra: Record<string, unknown> = {}): string {
  return broker({ indexSeq: 11, sessions, ...extra });
}

function scope(cwd: string, worktreeRoot: string | null = cwd) {
  return { version: 1, requested: "pwd", requestAnchor: { cwd, worktreeRoot } };
}

function saved(row: Record<string, unknown> = session(), id = "session-1", path = savedPath): string {
  return page([row], { savedSession: { id, path } });
}

interface Call {
  command: string;
  args: string[];
  options: GjcSdkCommandOptions;
}

function fakeRunner(
  output: readonly string[] | ((args: string[], call: number) => string | Promise<string>),
): { calls: Call[]; runner: GjcSdkCommandRunner } {
  const calls: Call[] = [];
  const runner: GjcSdkCommandRunner = async (command, args, options) => {
    const call = calls.length;
    calls.push({ command, args: [...args], options });
    if (typeof output === "function") return output(args, call);
    const response = output[call];
    if (response === undefined) throw new Error("Unexpected SDK command");
    return response;
  };
  return { calls, runner };
}

const commandArgs = [
  "sdk", "session", "raw", "global",
  "--op", "session.list",
  "--page", "--limit", "100",
  "--agent-dir", agentDir,
  "--attach-only", "--json",
];

describe("GJC SDK transcript identity binding", () => {
  it("ignores only the proven generation-zero direct-session GC fence after /new", async () => {
    mkdirSync(agentDir, { recursive: true });
    const fence = session({
      sessionId: "previous-session",
      endpointGeneration: 0,
      processIncarnation: "linux:12345",
      locator: { ...locator(), stateRoot: agentDir },
    });
    const valid = fakeRunner([page([fence, session()]), saved()]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, valid.runner))
      .resolves.toMatchObject({ sessionId: "session-1" });
    for (const invalid of [
      { ...fence, locator: { ...locator(), stateRoot: cwd } },
      { ...fence, terminalUncertain: true },
      { ...fence, ambiguous: true },
      { ...fence, processIncarnation: "linux:other" },
      { ...fence, endpointFileId: "unexpected-endpoint" },
    ]) {
      const { runner } = fakeRunner([page([invalid, session()]), saved()]);
      await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toBeNull();
    }
  });

  it("uses a null SDK worktree anchor for a directory outside Git", async () => {
    const row = session({ locator: { ...locator(), worktreeRoot: null } });
    const { calls, runner } = fakeRunner([page([row]), saved(row)]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner, async () => null))
      .resolves.toMatchObject({ sessionId: "session-1" });
    expect(calls[0]!.args).toEqual([...commandArgs, "--json-input", JSON.stringify({ scope: scope(cwd, null) })]);
  });

  it("resolves the matching process identity and the SDK's saved file", async () => {
    const { calls, runner } = fakeRunner([page([session()]), saved()]);

    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toEqual({
      sessionId: "session-1",
      pid: 321,
      path: savedPath,
      hostIncarnation: "linux:12345",
      endpointGeneration: 4,
    });
    expect(calls.map(({ command, args }) => [command, args])).toEqual([
      ["gjc", [...commandArgs, "--json-input", JSON.stringify({ scope: scope(cwd) })]],
      ["gjc", [...commandArgs, "--json-input", JSON.stringify({ cwd, resolveSessionId: "session-1" })]],
    ]);
  });

  it("paginates with the same limit and rejects conflicting page index sequences", async () => {
    const { calls, runner } = fakeRunner([
      page([session({ pid: 999 })], { continuationCursor: "next-page" }),
      page([session()]),
      saved(),
    ]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toMatchObject({ sessionId: "session-1" });
    expect(calls[0]!.args).toEqual([...commandArgs, "--json-input", JSON.stringify({ scope: scope(cwd) })]);
    expect(calls[1]!.args).toEqual([...commandArgs, "--json-input", JSON.stringify({ scope: scope(cwd), cursor: "next-page" })]);
    expect(calls[2]!.args).toEqual([...commandArgs, "--json-input", JSON.stringify({ cwd, resolveSessionId: "session-1" })]);

    const conflicting = fakeRunner([
      page([], { continuationCursor: "next-page" }),
      broker({ indexSeq: 12, sessions: [session()] }),
    ]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, conflicting.runner)).resolves.toBeNull();
    expect(conflicting.calls).toHaveLength(2);
  });

  it("does not choose by cwd alone when multiple pane GJC processes match", async () => {
    const { calls, runner } = fakeRunner([page([session(), session({ sessionId: "session-2", pid: 322 })])]);
    await expect(gjcSdkTranscriptWithRunner([321, 322], cwd, agentDir, runner)).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("scopes the scan so unrelated historical sessions beyond the page budget are excluded", async () => {
    const historical = Array.from({ length: 801 }, (_, index) => session({
      sessionId: `historical-${index}`,
      pid: 10_000 + index,
      live: false,
      locator: { cwd: join(cwd, `history-${index}`), worktreeRoot: null, stateRoot: join(cwd, ".gjc", "state") },
    }));
    const calls: Call[] = [];
    const runner: GjcSdkCommandRunner = async (command, args, options) => {
      const call = calls.length;
      calls.push({ command, args: [...args], options });
      const inputIndex = args.indexOf("--json-input");
      const input = inputIndex >= 0 ? JSON.parse(args[inputIndex + 1]!) : {};
      if (call === 0) {
        const rows = [...historical, session()].filter((row) => row.locator && (row.locator as Record<string, unknown>).cwd === input.scope?.requestAnchor.cwd);
        return page(rows);
      }
      return saved();
    };

    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toMatchObject({ sessionId: "session-1" });
    expect(calls[0]!.args).toEqual([...commandArgs, "--json-input", JSON.stringify({ scope: scope(cwd) })]);
    expect(calls).toHaveLength(2);
  });

  it("accepts a live session alongside definitively retired rows for the same pid", async () => {
    const terminal = session({ sessionId: "old-session", terminal: true, terminalUncertain: false });
    const deleted = session({ sessionId: "deleted-session", deleted: true });
    const { calls, runner } = fakeRunner([
      page([terminal, deleted, session()]),
      page([terminal, deleted, session()], { savedSession: { id: "session-1", path: savedPath } }),
    ]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toMatchObject({ sessionId: "session-1" });
    expect(calls).toHaveLength(2);
  });

  it("rejects competing active rows after exact lookup even when discovery was unique", async () => {
    const current = session();
    const competing = session({ sessionId: "session-2" });
    const { calls, runner } = fakeRunner([
      page([current]),
      page([current, competing], { savedSession: { id: "session-1", path: savedPath } }),
    ]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("uses the row's original symlinked cwd for exact resolution and matches its canonical identity", async () => {
    const alias = join(cwd, "cwd-alias");
    symlinkSync(cwd, alias, process.platform === "win32" ? "junction" : "dir");
    const discoveryRow = session({ locator: { ...locator(), cwd: alias } });
    const { calls, runner } = fakeRunner([page([discoveryRow]), saved()]);

    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toMatchObject({ sessionId: "session-1" });
    expect(calls[0]!.args).toEqual([...commandArgs, "--json-input", JSON.stringify({ scope: scope(cwd) })]);
    expect(calls[1]!.args).toEqual([...commandArgs, "--json-input", JSON.stringify({ cwd: alias, resolveSessionId: "session-1" })]);
  });

  it("anchors a pwd scope at its containing git worktree root", async () => {
    const nestedCwd = join(cwd, "nested");
    const worktreeAlias = join(cwd, "worktree-alias");
    mkdirSync(nestedCwd);
    symlinkSync(cwd, worktreeAlias, process.platform === "win32" ? "junction" : "dir");
    const row = session({ locator: { ...locator(), cwd: nestedCwd } });
    let receivedCwd = "";
    let receivedTimeout = 0;
    const rootResolver: GjcSdkWorktreeRootResolver = async (requestedCwd, timeoutMs) => {
      receivedCwd = requestedCwd;
      receivedTimeout = timeoutMs;
      return worktreeAlias;
    };
    const { calls, runner } = fakeRunner([
      page([row]),
      page([row], { savedSession: { id: "session-1", path: savedPath } }),
    ]);

    await expect(gjcSdkTranscriptWithRunner([321], nestedCwd, agentDir, runner, rootResolver)).resolves.toMatchObject({ sessionId: "session-1" });
    expect(receivedCwd).toBe(nestedCwd);
    expect(receivedTimeout).toBeGreaterThan(0);
    expect(receivedTimeout).toBeLessThanOrEqual(2_000);
    expect(calls[0]!.args).toEqual([
      ...commandArgs,
      "--json-input",
      JSON.stringify({ scope: scope(nestedCwd, cwd) }),
    ]);
  });

  it("fails closed when git cannot resolve a worktree root", async () => {
    let rootLookups = 0;
    const rootResolver: GjcSdkWorktreeRootResolver = async () => {
      rootLookups += 1;
      throw new Error("Git probe is unavailable");
    };
    const { calls, runner } = fakeRunner([page([session()]), saved()]);

    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner, rootResolver)).resolves.toBeNull();
    expect(rootLookups).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("distinguishes two same-cwd panes by each pane's supplied GJC pid", async () => {
    const rows = [session(), session({ sessionId: "session-2", pid: 322 })];
    const { runner } = fakeRunner((args, call) => {
      if (call % 2 === 0) return page(rows);
      const input = JSON.parse(args[args.indexOf("--json-input") + 1]!);
      const row = rows.find((candidate) => candidate.sessionId === input.resolveSessionId)!;
      return saved(row, row.sessionId as string, join(cwd, `${row.sessionId}.jsonl`));
    });

    const first = await gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner);
    const second = await gjcSdkTranscriptWithRunner([322], cwd, agentDir, runner);
    expect(first?.sessionId).toBe("session-1");
    expect(second?.sessionId).toBe("session-2");
  });

  it("fails closed for multiple live rows competing for one pane process", async () => {
    const { calls, runner } = fakeRunner([page([session(), session({ sessionId: "session-2" })])]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toBeNull();
    expect(calls).toHaveLength(1);

    const malformed = fakeRunner([page([session(), session({ identityProvenance: "legacy" })])]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, malformed.runner)).resolves.toBeNull();
    expect(malformed.calls).toHaveLength(1);

    const conflictingCwd = fakeRunner([page([session(), session({ locator: { ...locator(), cwd: join(cwd, "other") } })])]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, conflictingCwd.runner)).resolves.toBeNull();
    expect(conflictingCwd.calls).toHaveLength(1);
  });

  it("observes a /new session on the next call without retaining a resolved path", async () => {
    const { calls, runner } = fakeRunner((_args, call) => {
      const turn = Math.floor(call / 2);
      const row = session({ sessionId: `session-${turn + 1}` });
      return call % 2 === 0 ? page([row]) : saved(row, `session-${turn + 1}`, join(cwd, `session-${turn + 1}.jsonl`));
    });

    const first = await gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner);
    const second = await gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner);
    expect(first?.sessionId).toBe("session-1");
    expect(second).toEqual({
      sessionId: "session-2",
      pid: 321,
      path: join(cwd, "session-2.jsonl"),
      hostIncarnation: "linux:12345",
      endpointGeneration: 4,
    });
    expect(calls).toHaveLength(4);
  });

  it("ignores stale, deleted, terminal, legacy, uncertain, and unrelated rows", async () => {
    const invalidRows: Record<string, unknown>[] = [
      { live: false },
      { deleted: true },
      { terminal: true },
      { terminalUncertain: true },
      { ambiguous: true },
      { identityProvenance: "legacy" },
      { endpointGeneration: 0 },
      { hostIncarnation: " " },
      { pid: 999 },
      { locator: { ...locator(), cwd: join(cwd, "other") } },
    ];
    for (const invalid of invalidRows) {
      const { calls, runner } = fakeRunner([page([session(invalid)])]);
      await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toBeNull();
      expect(calls).toHaveLength(1);
    }
  });

  it("rechecks the full locator, generation, and host incarnation before returning a path", async () => {
    const changedRows = [
      session({ endpointGeneration: 5 }),
      session({ hostIncarnation: "linux:next" }),
      session({ locator: { ...locator(), stateRoot: join(cwd, "other-state") } }),
    ];
    for (const changed of changedRows) {
      const { calls, runner } = fakeRunner([page([session()]), saved(changed)]);
      await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toBeNull();
      expect(calls).toHaveLength(2);
    }
  });

  it("rejects an exact lookup from an older broker index sequence", async () => {
    const older = broker({ indexSeq: 10, sessions: [session()], savedSession: { id: "session-1", path: savedPath } });
    const { calls, runner } = fakeRunner([page([session()]), older]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("requires the exact saved session and an absolute path", async () => {
    const invalidSavedSessions = [
      undefined,
      { id: "another-session", path: savedPath },
      { id: "session-1", path: "relative/session.jsonl" },
    ];
    for (const savedSession of invalidSavedSessions) {
      const result = page([session()], savedSession === undefined ? {} : { savedSession });
      const { runner } = fakeRunner([page([session()]), result]);
      await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toBeNull();
    }
  });

  it("refuses an incomplete exact lookup rather than accepting its saved path", async () => {
    const { runner } = fakeRunner([
      page([session()]),
      page([session()], { continuationCursor: "incomplete", savedSession: { id: "session-1", path: savedPath } }),
    ]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toBeNull();
  });

  it("ends a hung SDK lookup at its deadline", async () => {
    let calls = 0;
    const runner: GjcSdkCommandRunner = () => {
      calls += 1;
      return new Promise(() => {});
    };
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toBeNull();
    expect(calls).toBe(1);
  });

  it("rejects malformed broker output and repeated or over-budget pagination", async () => {
    for (const output of ["not json", JSON.stringify({ type: "broker_response", ok: false, result: {} }), broker({ indexSeq: 1, sessions: {} })]) {
      const { runner } = fakeRunner([output]);
      await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toBeNull();
    }

    const repeated = fakeRunner([page([], { continuationCursor: "same" }), page([], { continuationCursor: "same" })]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, repeated.runner)).resolves.toBeNull();
    expect(repeated.calls).toHaveLength(2);

    for (const cursor of ["", "  ", 7, { token: "cursor" }]) {
      const malformed = fakeRunner([page([], { continuationCursor: cursor })]);
      await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, malformed.runner)).resolves.toBeNull();
      expect(malformed.calls).toHaveLength(1);
    }

    const pages = fakeRunner((_args, call) => page([], { continuationCursor: `cursor-${call}` }));
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, pages.runner)).resolves.toBeNull();
    expect(pages.calls).toHaveLength(8);
  });

  it("keeps SDK execution bounded, non-interactive, and quiet on transport failure", async () => {
    let captured: Call | undefined;
    const runner: GjcSdkCommandRunner = async (command, args, options) => {
      captured = { command, args: [...args], options };
      throw new Error("broker credentials and local paths must not escape");
    };

    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toBeNull();
    expect(captured?.command).toBe("gjc");
    expect(captured?.args).toEqual([...commandArgs, "--json-input", JSON.stringify({ scope: scope(cwd) })]);
    expect(captured?.options.env.GJC_SDK_BROKER_AUTOSTART).toBe("0");
    expect(captured?.options.shell).toBe(false);
    expect(captured?.options).not.toHaveProperty("stdio");
    expect(captured?.options.maxBuffer).toBe(1024 * 1024);
    expect(captured?.options.timeout).toBeGreaterThan(0);
    expect(captured?.options.timeout).toBeLessThanOrEqual(2_000);
    expect(captured?.options.killSignal).toBe("SIGKILL");
  });
});
