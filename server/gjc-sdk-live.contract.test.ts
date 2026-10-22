import { expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { accessSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ConversationUnavailable, forgetTranscriptState, gjcTranscriptPath, transcriptPage } from "./conversation.ts";
import { herdrRpc, herdrSocketPath, paneRead, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { isGjcProcess } from "./gjc-runtime.ts";

const TEST_BIN = process.env["HERDR_GJC_SDK_TEST_BIN"];
const SUPPORTED_PLATFORM = process.platform === "linux";
const TEST_TIMEOUT_MS = 90_000;
const PROCESS_STOP_TIMEOUT_MS = 3_000;
const SDK_COMMAND_TIMEOUT_MS = 3_000;

type JsonRecord = Record<string, unknown>;
type PaneProcess = { pid?: unknown; argv?: unknown };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sdkArgs(agentDir: string, input?: Record<string, string>): string[] {
  const args = [
    "sdk", "session", "raw", "global",
    "--op", "session.list",
    "--page", "--limit", "100",
    "--agent-dir", agentDir,
    "--attach-only", "--json",
  ];
  if (input !== undefined) args.push("--json-input", JSON.stringify(input));
  return args;
}

function sdkResult(agentDir: string, input?: Record<string, string>): JsonRecord {
  const stdout = execFileSync("gjc", sdkArgs(agentDir, input), {
    env: { ...process.env, GJC_SDK_BROKER_AUTOSTART: "0" },
    encoding: "utf8",
    timeout: SDK_COMMAND_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const envelope: unknown = JSON.parse(stdout);
  if (!isRecord(envelope) || envelope.type !== "broker_response" || envelope.ok !== true || !isRecord(envelope.result)) {
    throw new Error("GJC SDK returned an invalid broker response");
  }
  return envelope.result;
}

function rowForPid(result: JsonRecord, pid: number, cwd: string): JsonRecord | null {
  if (!Array.isArray(result.sessions)) return null;
  const rows = result.sessions.filter((row): row is JsonRecord => isRecord(row));
  const matches = rows.filter((row) => {
    const locator = row.locator;
    return row.pid === pid && row.live === true && row.terminal !== true && row.deleted !== true
      && typeof row.endpointGeneration === "number" && row.endpointGeneration > 0
      && isRecord(locator) && locator.cwd === cwd;
  });
  return matches.length === 1 ? matches[0]! : null;
}

async function until<T>(
  deadline: number,
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  label: string,
): Promise<T> {
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (accept(value)) return value;
      last = value;
    } catch (error) {
      last = error;
    }
    await Bun.sleep(100);
  }
  const detail = last instanceof Error ? `: ${last.message}`
    : isRecord(last) && typeof last.text === "string" ? `\nIsolated TUI: ${last.text}` : "";
  throw new Error(`Timed out waiting for ${label}${detail}`);
}

async function foregroundGjcPid(paneId: string, socketPath: string): Promise<number | null> {
  const response = await herdrRpc<{ process_info?: { foreground_processes?: PaneProcess[] } }>(
    "pane.process_info", { pane_id: paneId }, socketPath, 2_000,
  );
  const matches = (response.process_info?.foreground_processes ?? []).filter((process) => {
    const argv = Array.isArray(process.argv) ? process.argv.map(String) : [];
    return typeof process.pid === "number" && isGjcProcess(argv);
  });
  return matches.length === 1 ? matches[0]!.pid as number : null;
}

function transcriptRecords(sessionId: string, cwd: string, title: string, timestamp: string): string {
  const userId = randomUUID();
  const assistantId = randomUUID();
  return [
    { type: "session", version: 3, id: sessionId, timestamp, cwd, title },
    {
      type: "message", id: userId, parentId: null, timestamp,
      message: { role: "user", content: "Answer with one short word: what is the result?" },
    },
    {
      type: "message", id: assistantId, parentId: userId, timestamp,
      message: {
        role: "assistant", content: [{ type: "text", text: "OK" }],
        stopReason: "stop", model: "gpt-4.1", provider: "openai",
      },
    },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n";
}

function hasNativeHeader(path: string, sessionId: string, cwd: string): boolean {
  try {
    const header: unknown = JSON.parse(readFileSync(path, "utf8").split("\n", 1)[0]!);
    return isRecord(header) && header.type === "session" && header.id === sessionId && header.cwd === cwd;
  } catch {
    return false;
  }
}

function launchLine(binary: string, envPath: string, home: string, configHome: string, stateHome: string, cacheHome: string, resume?: string): string {
  const args = [
    shellQuote(binary),
    "--no-lsp", "--no-mcp", "--no-title", "--no-pty",
    "--model", shellQuote("openai/gpt-4.1"),
    "--api-key", shellQuote("test-only-no-model-requests"),
    ...(resume === undefined ? [] : ["--resume", shellQuote(resume)]),
  ];
  return [
    "/usr/bin/env -i",
    `HOME=${shellQuote(home)}`,
    `PATH=${shellQuote(envPath)}`,
    `TERM=${shellQuote("xterm-256color")}`,
    `XDG_CONFIG_HOME=${shellQuote(configHome)}`,
    `XDG_STATE_HOME=${shellQuote(stateHome)}`,
    `XDG_CACHE_HOME=${shellQuote(cacheHome)}`,
    ...args,
  ].join(" ") + "\n";
}

function ownedProcesses(home: string): number[] {
  const marker = `HOME=${home}`;
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch (error) {
    throw new Error(`Cannot inspect Linux process environment for isolated GJC cleanup: ${String(error)}`);
  }
  const pids: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    try {
      const environment = readFileSync(`/proc/${entry}/environ`, "utf8");
      if (environment.split("\0").includes(marker)) pids.push(pid);
    } catch {
      // Exited processes and processes owned by another user are not candidates.
    }
  }
  return pids;
}

async function stopOwnedProcesses(home: string): Promise<void> {
  const signal = (pids: number[], value: NodeJS.Signals) => {
    for (const pid of pids) {
      try { process.kill(pid, value); } catch { /* exited between enumeration and signal */ }
    }
  };
  const waitGone = async (deadline: number): Promise<number[]> => {
    let live = ownedProcesses(home);
    while (live.length > 0 && Date.now() < deadline) {
      await Bun.sleep(100);
      live = ownedProcesses(home);
    }
    return live;
  };

  signal(ownedProcesses(home), "SIGTERM");
  let live = await waitGone(Date.now() + PROCESS_STOP_TIMEOUT_MS);
  if (live.length > 0) {
    signal(live, "SIGKILL");
    live = await waitGone(Date.now() + PROCESS_STOP_TIMEOUT_MS);
  }
  if (live.length > 0) throw new Error(`Isolated GJC processes survived cleanup: ${live.join(",")}`);
}

it.skipIf(!TEST_BIN || !SUPPORTED_PLATFORM)(
  "resolves a live GJC session through the public SDK without model requests (opt-in: HERDR_GJC_SDK_TEST_BIN; Linux /proc)",
  async () => {
    if (!TEST_BIN) throw new Error("HERDR_GJC_SDK_TEST_BIN must be an absolute executable path");
    if (!SUPPORTED_PLATFORM) throw new Error("The live SDK contract test currently requires Linux /proc cleanup");

    const socketPath = herdrSocketPath();
    const systemPath = process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin";
    const envSnapshot: NodeJS.ProcessEnv = { ...process.env };
    const suppliedBin = TEST_BIN;
    let root: string | null = null;
    let home = "";
    let workspaceIds: string[] = [];
    let environmentWasReplaced = false;
    let isolatedChildrenGone = true;
    let failed = false;

    try {
      expect(isAbsolute(suppliedBin)).toBe(true);
      accessSync(suppliedBin, constants.X_OK);
      const binary = realpathSync(suppliedBin);
      expect(statSync(binary).isFile()).toBe(true);

      root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-test-gjc-sdk-live-")));
      home = join(root, "home");
      const cwd = join(root, "project");
      const configHome = join(home, ".config");
      const stateHome = join(home, ".local", "state");
      const cacheHome = join(home, ".cache");
      const agentDir = join(home, ".gjc", "agent");
      const shimDir = join(root, "bin");
      const tmpHome = join(root, "tmp");
      for (const directory of [home, cwd, configHome, stateHome, cacheHome, agentDir, shimDir, tmpHome]) {
        mkdirSync(directory, { recursive: true });
      }
      symlinkSync(binary, join(shimDir, "gjc"));
      const isolatedPath = `${shimDir}:${systemPath}`;

      environmentWasReplaced = true;
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, {
        HOME: home,
        PATH: isolatedPath,
        TERM: "xterm-256color",
        LANG: "C.UTF-8",
        TMPDIR: tmpHome,
        XDG_CONFIG_HOME: configHome,
        XDG_STATE_HOME: stateHome,
        XDG_CACHE_HOME: cacheHome,
        HERDR_SOCKET: socketPath,
      });
      // The SDK's pwd scope still requires the canonical Git worktree identity.
      execFileSync("git", ["init", "--quiet", cwd], {
        env: process.env, stdio: "ignore", timeout: 3_000,
      });

      const startPane = async (label: string, resume?: string): Promise<{ workspaceId: string; paneId: string }> => {
        const created = await workspaceCreate({ cwd, label: `ovis-test-gjc-sdk-live-${label}` }, socketPath);
        workspaceIds.push(created.workspace.workspace_id);
        await herdrRpc("pane.send_text", {
          pane_id: created.root_pane.pane_id,
          text: launchLine(binary, isolatedPath, home, configHome, stateHome, cacheHome, resume),
        }, socketPath, 3_000);
        return { workspaceId: created.workspace.workspace_id, paneId: created.root_pane.pane_id };
      };

      const sdkRowForPane = async (paneId: string): Promise<{ pid: number; row: JsonRecord } | null> => {
        const pid = await foregroundGjcPid(paneId, socketPath);
        if (pid === null) return null;
        const result = sdkResult(agentDir);
        const row = rowForPid(result, pid, cwd);
        return row === null ? null : { pid, row };
      };

      const firstPane = await startPane("bootstrap");
      const first = await until(
        Date.now() + 30_000,
        () => sdkRowForPane(firstPane.paneId),
        (value) => value !== null,
        "the bootstrap GJC SDK row for the foreground pane PID",
      );
      if (first === null) throw new Error("Bootstrap SDK row disappeared after its bounded poll");
      const sessionId = first.row.sessionId;
      expect(typeof sessionId).toBe("string");
      expect((sessionId as string).length).toBeGreaterThan(0);
      expect(first.row.pid).toBe(first.pid);

      await workspaceClose(firstPane.workspaceId, socketPath);
      workspaceIds = workspaceIds.filter((id) => id !== firstPane.workspaceId);
      await until(
        Date.now() + 5_000,
        async () => {
          try { process.kill(first.pid, 0); return true; } catch { return false; }
        },
        (alive) => !alive,
        "the bootstrap GJC process to exit after its workspace closes",
      );

      const resumedSessionId = sessionId as string;
      expect(resumedSessionId).toMatch(/^[a-zA-Z0-9_-]+$/);
      const sessionsRoot = join(agentDir, "sessions");
      const scopeDirs = await until(
        Date.now() + 10_000,
        async () => {
          try {
            return readdirSync(sessionsRoot, { withFileTypes: true })
              .filter((entry) => entry.isDirectory() && entry.name.startsWith("v2-"))
              .map((entry) => join(sessionsRoot, entry.name));
          } catch { return []; }
        },
        (dirs) => dirs.length === 1,
        "the single isolated native GJC v2 session scope",
      );
      expect(scopeDirs).toHaveLength(1);
      const scopeDir = scopeDirs[0]!;
      expect(realpathSync(scopeDir)).toBe(scopeDir);

      const fixtureTimestamp = new Date().toISOString();
      const existingSessionFiles = readdirSync(scopeDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(`_${resumedSessionId}.jsonl`))
        .map((entry) => join(scopeDir, entry.name));
      expect(existingSessionFiles.length).toBeLessThanOrEqual(1);
      const existingSessionPath = existingSessionFiles[0];
      const reuseExisting = existingSessionPath !== undefined && hasNativeHeader(existingSessionPath, resumedSessionId, cwd);
      expect(existingSessionPath === undefined || reuseExisting).toBe(true);
      const fixtureSessionId = resumedSessionId;
      const fixtureName = `${fixtureTimestamp.replaceAll(":", "-")}_${fixtureSessionId}.jsonl`;
      const fixturePath = reuseExisting ? existingSessionPath : join(scopeDir, fixtureName);
      if (!reuseExisting) {
        const collision = readdirSync(scopeDir, { withFileTypes: true })
          .some((entry) => entry.isFile() && entry.name.endsWith(`_${fixtureSessionId}.jsonl`));
        expect(collision).toBe(false);
      }
      const title = "GJC SDK identity fixture";
      writeFileSync(fixturePath, transcriptRecords(fixtureSessionId, cwd, title, fixtureTimestamp));

      // Same visible title and turns, but newer than the resumed file: screen/mtime guessing cannot
      // tell which one the live process owns. Only the SDK's PID-to-session binding can.
      const neighborId = randomUUID();
      const neighborPath = join(scopeDir, `${new Date().toISOString().replaceAll(":", "-")}_${neighborId}.jsonl`);
      writeFileSync(neighborPath, transcriptRecords(neighborId, cwd, title, fixtureTimestamp));
      const newerTime = new Date(Date.now() + 10 * 60_000);
      utimesSync(neighborPath, newerTime, newerTime);
      expect(statSync(neighborPath).mtimeMs).toBeGreaterThan(statSync(fixturePath).mtimeMs);

      const resumedPane = await startPane("resume", fixturePath);
      const resumed = await until(
        Date.now() + 30_000,
        () => sdkRowForPane(resumedPane.paneId),
        (value) => value !== null,
        "the resumed GJC SDK row for the foreground pane PID",
      );
      if (resumed === null) throw new Error("Resumed SDK row disappeared after its bounded poll");
      expect(resumed.row.pid).toBe(resumed.pid);
      expect(resumed.row.sessionId).toBe(fixtureSessionId);

      const brokerResolution = sdkResult(agentDir, { cwd, resolveSessionId: fixtureSessionId });
      expect(isRecord(brokerResolution.savedSession)).toBe(true);
      expect(isRecord(brokerResolution.savedSession) ? brokerResolution.savedSession.id : null).toBe(fixtureSessionId);
      expect(isRecord(brokerResolution.savedSession) ? brokerResolution.savedSession.path : null).toBe(fixturePath);

      const resolvedPath = await gjcTranscriptPath(resumedPane.paneId, cwd, home);
      expect(resolvedPath).toBe(fixturePath);
      const conversation = transcriptPage("gjc-transcript", resolvedPath);
      expect(conversation.source).toBe("gjc-transcript");
      const assistant = conversation.turns.find((turn) => turn.role === "assistant");
      expect(assistant?.parts).toContainEqual({ kind: "text", text: "OK" });

      // A real GJC may hold its transcript open. That must not become an identity fallback
      // when the SDK CLI fails: replace only our disposable PATH shim, not the supplied binary.
      // Force discovery rather than relying on an incidental heartbeat to expire a kept binding.
      forgetTranscriptState();
      unlinkSync(join(shimDir, "gjc"));
      writeFileSync(join(shimDir, "gjc"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      await expect(gjcTranscriptPath(resumedPane.paneId, cwd, home)).rejects.toBeInstanceOf(ConversationUnavailable);
      unlinkSync(join(shimDir, "gjc"));
      symlinkSync(binary, join(shimDir, "gjc"));

      // A disposable HOME gets a language selector and then onboarding. Escape chooses
      // English in the first and cancels the second; neither starts evidence analysis.
      const dismissed = new Set<string>();
      await until(
        Date.now() + 10_000,
        async () => {
          const screen = await paneRead({ paneId: resumedPane.paneId, source: "visible", lines: 100 }, socketPath);
          const menu = ["Choose your interface language", "Frictionless onboarding"]
            .find((title) => screen.text.includes(title));
          if (menu && !dismissed.has(menu)) {
            dismissed.add(menu);
            await herdrRpc("pane.send_keys", { pane_id: resumedPane.paneId, keys: ["Escape"] }, socketPath);
          }
          return screen;
        },
        (screen) => screen.text.includes("Type your message") && !screen.text.includes("Frictionless onboarding"),
        "the isolated GJC editor after dismissing onboarding",
      );
      await herdrRpc("pane.send_text", { pane_id: resumedPane.paneId, text: "/new" }, socketPath);
      await herdrRpc("pane.send_keys", { pane_id: resumedPane.paneId, keys: ["Enter"] }, socketPath);
      const nextSession = await until(
        Date.now() + 15_000,
        () => sdkRowForPane(resumedPane.paneId),
        (value) => value !== null && value.row.sessionId !== fixtureSessionId,
        "the real TUI /new command to publish a different SDK session",
      ).catch(async (error) => {
        const screen = await paneRead({ paneId: resumedPane.paneId, source: "visible", lines: 100 }, socketPath);
        throw new Error(`${String(error)}\nIsolated TUI: ${screen.text}\nIsolated SDK: ${JSON.stringify(sdkResult(agentDir))}`);
      });
      if (nextSession === null) throw new Error("New SDK session disappeared");
      expect(nextSession.pid).toBe(resumed.pid);
      expect(nextSession.row.sessionId).not.toBe(fixtureSessionId);
      const nextId = nextSession.row.sessionId;
      if (typeof nextId !== "string") throw new Error("New SDK session ID is not a string");
      expect(nextId).toMatch(/^[a-zA-Z0-9_-]+$/);
      const nextSaved = sdkResult(agentDir, { cwd, resolveSessionId: nextId }).savedSession;
      if (isRecord(nextSaved)) {
        if (typeof nextSaved.path !== "string") throw new Error("New SDK transcript path is not a string");
        expect(nextSaved.path).not.toBe(fixturePath);
        expect(await gjcTranscriptPath(resumedPane.paneId, cwd, home)).toBe(nextSaved.path);
      } else {
        await expect(gjcTranscriptPath(resumedPane.paneId, cwd, home)).rejects.toBeInstanceOf(ConversationUnavailable);
        // Persist fixture history for the actual new session without making a model request.
        // A lingering generation-zero GC fence for the old session must not block this one.
        const existing = readdirSync(scopeDir).filter((name) => name.endsWith(`_${nextId}.jsonl`));
        expect(existing.length).toBeLessThanOrEqual(1);
        const nextPath = join(scopeDir, existing[0] ?? `${new Date().toISOString().replaceAll(":", "-")}_${nextId}.jsonl`);
        writeFileSync(nextPath, transcriptRecords(nextId, cwd, "New session fixture", new Date().toISOString()));
        expect(await gjcTranscriptPath(resumedPane.paneId, cwd, home)).toBe(nextPath);
        expect(nextPath).not.toBe(fixturePath);
      }

    } catch (error) {
      failed = true;
      throw error;
    } finally {
      const cleanupErrors: string[] = [];
      for (const workspaceId of [...workspaceIds].reverse()) {
        try { await workspaceClose(workspaceId, socketPath); }
        catch (error) { cleanupErrors.push(`workspace ${workspaceId}: ${String(error)}`); }
      }
      if (home !== "") {
        try { await stopOwnedProcesses(home); }
        catch (error) {
          isolatedChildrenGone = false;
          cleanupErrors.push(String(error));
        }
      }
      if (environmentWasReplaced) {
        for (const key of Object.keys(process.env)) delete process.env[key];
        for (const [key, value] of Object.entries(envSnapshot)) {
          if (value !== undefined) process.env[key] = value;
        }
      }
      forgetTranscriptState();
      if (root !== null && isolatedChildrenGone) rmSync(root, { recursive: true, force: true });
      if (cleanupErrors.length > 0) {
        const message = `GJC SDK live-test cleanup failed: ${cleanupErrors.join("; ")}`;
        // the test's own failure is the one to report; a cleanup failure beside it is only logged
        if (failed) console.error(message);
        else throw new Error(message);
      }
    }
  },
  TEST_TIMEOUT_MS,
);
