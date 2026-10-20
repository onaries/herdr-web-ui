import { afterAll, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrRpc, herdrSocketPath, sessionSnapshot, workspaceClose, workspaceCreate, paneRead } from "./herdr/client.ts";
import { ConversationUnavailable, forgetTranscriptState, gjcTranscriptPath, paneConversation } from "./conversation.ts";
import { isGjcProcess } from "./gjc-runtime.ts";
import { startShellAgent } from "./shell-agent.ts";
import { createServer } from "./index.ts";

const home = realpathSync(mkdtempSync(join(tmpdir(), "herdr-gjc-binding-")));
const agentDir = join(home, ".gjc", "agent");
const dir = join(agentDir, "sessions", "v2-shared");
mkdirSync(dir, { recursive: true });
const workspaces: string[] = [];
const script = join(home, "gjc");
const bin = join(home, "bin");
const registry = join(home, "sdk-registry.json");
const sdkCli = join(home, "gjc-sdk-fixture.js");
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// The stand-in is a Bun script named gjc; it holds only the requested store directory and prints the pane's fixed screen.
writeFileSync(script, "if (process.env.GJC_TEST_CWD) process.chdir(process.env.GJC_TEST_CWD);\nfor (const path of process.argv.slice(2)) require('node:fs').openSync(path, 'r');\nconsole.log('GJC fixture ready'); console.log(process.env.GJC_TEST_SCREEN || ''); setInterval(() => {}, 1000);\n");
mkdirSync(bin);
// The fixture accepts only the public raw global session.list operation. Its registry is test-owned JSON, never SDK state.
writeFileSync(sdkCli, `
const { appendFileSync, readFileSync } = require("node:fs");
if (process.env.GJC_TEST_CALLS) appendFileSync(process.env.GJC_TEST_CALLS, "sdk\\n");
const args = process.argv.slice(2);
const value = (flag) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
if (args[0] !== "sdk" || args[1] !== "session" || args[2] !== "raw" || args[3] !== "global"
  || args[4] !== "--op" || args[5] !== "session.list"
  || !args.includes("--attach-only") || !args.includes("--json")
  || value("--agent-dir") !== process.env.GJC_TEST_AGENT_DIR
  || !args.includes("--page") || value("--limit") !== "100") process.exit(64);
let state;
try { state = JSON.parse(readFileSync(process.env.GJC_TEST_REGISTRY, "utf8")); }
catch { process.exit(1); }
if (state.kind === "unavailable") {
  process.stdout.write(JSON.stringify({ type: "broker_response", ok: false, error: { code: "broker_unavailable" } }));
  process.exit(1);
}
if (state.kind === "malformed") { process.stdout.write("not-json"); process.exit(0); }
if (state.kind === "timeout") await new Promise(() => { setInterval(() => {}, 1000); });
let input;
try { if (value("--json-input") !== undefined) input = JSON.parse(value("--json-input")); }
catch { process.exit(64); }
let sessions = state.rows;
let savedSession;
let savedSessionOmission;
if (input && input.scope) {
  const scope = input.scope;
  if (scope.version !== 1 || scope.requested !== "pwd" || !scope.requestAnchor
    || typeof scope.requestAnchor.cwd !== "string" || scope.requestAnchor.worktreeRoot !== null) process.exit(64);
  sessions = sessions.filter((row) => row.locator.cwd === scope.requestAnchor.cwd);
}
if (input && typeof input.resolveSessionId === "string") {
  sessions = sessions.filter((row) => row.sessionId === input.resolveSessionId && row.locator.cwd === input.cwd);
  const path = state.paths && state.paths[input.resolveSessionId];
  if (typeof path === "string") savedSession = { id: input.resolveSessionId, path };
  else savedSessionOmission = { reason: "not_found", detailCode: "saved_session_omitted" };
}
const result = { indexSeq: 1, sessions, warnings: [] };
if (savedSession !== undefined) result.savedSession = savedSession;
if (savedSessionOmission !== undefined) result.savedSessionOmission = savedSessionOmission;
process.stdout.write(JSON.stringify({ type: "broker_response", ok: true, result }));
`);
// Non-SDK invocations are the executable-path contract's pane stand-in, not another SDK response path.
writeFileSync(join(bin, "gjc"), `#!/bin/sh\nif [ "$1" = "sdk" ]; then exec ${shellQuote(process.execPath)} ${shellQuote(sdkCli)} "$@"; fi\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`, { mode: 0o755 });

afterAll(async () => {
  const previousSocket = process.env["HERDR_SOCKET"];
  process.env["HERDR_SOCKET"] = herdrSocketPath();
  try {
    for (const workspace of workspaces) await workspaceClose(workspace);
  } finally {
    if (previousSocket === undefined) delete process.env["HERDR_SOCKET"]; else process.env["HERDR_SOCKET"] = previousSocket;
    rmSync(home, { recursive: true, force: true });
  }
});

/** Paths a process holds open: /proc on Linux, lsof on macOS. */
function heldPaths(pid: number): string[] {
  if (process.platform === "linux") {
    return readdirSync(`/proc/${pid}/fd`).flatMap((fd) => { try { return [readlinkSync(`/proc/${pid}/fd/${fd}`)]; } catch { return []; } });
  }
  const lsof = Bun.spawnSync(["/usr/sbin/lsof", "-nP", "-a", "-p", String(pid), "-Fn"], { stdout: "pipe", stderr: "ignore" });
  return lsof.stdout.toString().split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1));
}

async function pane(paths: string[], screen = "", cwd = home): Promise<string> {
  const created = await workspaceCreate({ cwd: home, label: "herdr-web-ui-test-gjc-binding" });
  workspaces.push(created.workspace.workspace_id);
  const id = created.root_pane.pane_id;
  const args = paths.map(shellQuote).join(" ");
  const command = `GJC_TEST_CWD=${shellQuote(cwd)} GJC_TEST_SCREEN=${shellQuote(screen)} ${shellQuote(process.execPath)} ${shellQuote(script)} ${args}\n`;
  await herdrRpc("pane.send_text", { pane_id: id, text: command });
  for (let attempt = 0; attempt < 100; attempt++) {
    const info = await herdrRpc<{ process_info?: { foreground_processes?: { pid: number; argv?: string[] }[] } }>("pane.process_info", { pane_id: id });
    const process = info.process_info?.foreground_processes?.find((candidate) => candidate.argv?.includes(script));
    if (process && paths.every((path) => heldPaths(process.pid).includes(path))) return id;
    await Bun.sleep(50);
  }
  throw new Error("GJC stand-in did not open its store descriptor in the pane");
}

async function gjcProcess(id: string): Promise<{ pid: number; argv: string[] }> {
  const info = await herdrRpc<{ process_info?: { foreground_processes?: { pid?: number; argv?: string[] }[] } }>("pane.process_info", { pane_id: id });
  const found = info.process_info?.foreground_processes?.find((candidate) => candidate.argv?.includes(script) && isGjcProcess(candidate.argv));
  if (typeof found?.pid !== "number" || !found.argv) throw new Error("pane.process_info did not expose the Bun GJC stand-in");
  return { pid: found.pid, argv: found.argv };
}

async function waitForScreen(id: string, text: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await paneRead({ paneId: id })).text.includes(text)) return;
    await Bun.sleep(50);
  }
  throw new Error("GJC stand-in screen text did not appear in the pane");
}

async function setAgent(id: string, agent: string): Promise<void> {
  await herdrRpc("pane.report_agent", { pane_id: id, source: "manual", agent, state: "idle" });
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await sessionSnapshot()).panes.find((item) => item.pane_id === id)?.agent === agent) return;
    await Bun.sleep(50);
  }
  throw new Error(`herdr did not report ${agent} for the fixture pane`);
}

function sdkRow(pid: number, cwd: string, sessionId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId,
    locator: { cwd, worktreeRoot: null, stateRoot: join(cwd, ".gjc", "state") },
    endpointGeneration: 1,
    pid,
    live: true,
    terminal: false,
    deleted: false,
    ambiguous: false,
    terminalUncertain: false,
    identityProvenance: "composite",
    hostIncarnation: "test-host-incarnation",
    indexSeq: 1,
    ...overrides,
  };
}

function writeRegistry(rows: Record<string, unknown>[], paths: Record<string, string> = {}, kind?: string): void {
  writeFileSync(registry, JSON.stringify({ rows, paths, ...(kind ? { kind } : {}) }));
}

async function withSdkFixture<T>(run: () => Promise<T>): Promise<T> {
  const keys = ["HOME", "HERDR_SOCKET", "PATH", "GJC_TEST_REGISTRY", "GJC_TEST_AGENT_DIR", "GJC_TEST_CALLS"] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env["HOME"] = home;
  process.env["HERDR_SOCKET"] = herdrSocketPath();
  process.env["PATH"] = `${bin}${process.env["PATH"] ? `:${process.env["PATH"]}` : ""}`;
  process.env["GJC_TEST_REGISTRY"] = registry;
  process.env["GJC_TEST_AGENT_DIR"] = agentDir;
  try {
    return await run();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

function record(cwd: string, answer: string, id: string, title = "shared title"): string {
  return JSON.stringify({ type: "session", cwd, id, title }) + "\n"
    + JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: answer }] } }) + "\n";
}

function signedSdkIndexRow(
  indexSeq: number,
  type: string,
  sessionId: string,
  pid: number,
  ts: number,
): string {
  const unsigned = {
    version: 4,
    indexSeq,
    type,
    sessionId,
    locator: { cwd: home, worktreeRoot: null, stateRoot: home },
    pid,
    processIncarnation: `test-process-${pid}`,
    hostIncarnation: "test-host-incarnation",
    endpointGeneration: 1,
    activity: { state: "idle", at: ts },
    ts,
  };
  const checksum = createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
  return `${JSON.stringify({ ...unsigned, checksum })}\n`;
}

async function expectConversation(id: string, answer: string): Promise<void> {
  const conversation = await paneConversation(id);
  expect(conversation.source).toBe("gjc-transcript");
  expect(conversation.turns[0]!.parts[0]).toMatchObject({ kind: "text", text: answer });
}

it("SDK identity ignores a copied neighboring answer on the pane screen", async () => withSdkFixture(async () => {
  const a = join(dir, "sdk-answer-a.jsonl"), b = join(dir, "sdk-answer-b.jsonl");
  const otherAnswer = "This long neighboring response is deliberately unique so visible screen matching would choose this wrong transcript instead of the short SDK-owned answer.";
  writeFileSync(a, record(home, "OK", "sdk-answer-a"));
  writeFileSync(b, record(home, otherAnswer, "sdk-answer-b"));
  const id = await pane([dir], otherAnswer);
  await waitForScreen(id, otherAnswer.slice(0, 40));
  const { pid, argv } = await gjcProcess(id);
  expect(argv).toContain(script);
  expect(argv[0]).toBe(process.execPath);
  writeRegistry([sdkRow(pid, home, "sdk-answer-a")], { "sdk-answer-a": a });

  expect(heldPaths(pid)).not.toContain(a);
  expect(await gjcTranscriptPath(id, home, home)).toBe(a);
  await expectConversation(id, "OK");
}));

it("keeps subprocess-resolved SDK pane bindings across unrelated signed heartbeat appends and invalidates /new", async () => withSdkFixture(async () => {
  const indexDir = join(agentDir, "sdk", "sessions");
  const indexPath = join(indexDir, "index.jsonl");
  const callsPath = join(home, "sdk-cli-calls.log");
  try {
    mkdirSync(indexDir, { recursive: true });
    process.env["GJC_TEST_CALLS"] = callsPath;

    const firstSession = "heartbeat-pane-first";
    const secondSession = "heartbeat-pane-second";
    const freshSession = "heartbeat-pane-first-new";
    const firstPath = join(dir, `${firstSession}.jsonl`);
    const secondPath = join(dir, `${secondSession}.jsonl`);
    const freshPath = join(dir, `${freshSession}.jsonl`);
    writeFileSync(firstPath, record(home, "first answer", firstSession));
    writeFileSync(secondPath, record(home, "second answer", secondSession));
    writeFileSync(freshPath, record(home, "fresh answer", freshSession));

    const firstPane = await pane([dir], "first answer");
    const secondPane = await pane([dir], "second answer");
    await waitForScreen(firstPane, "first answer");
    await waitForScreen(secondPane, "second answer");
    await setAgent(firstPane, "gjc");
    await setAgent(secondPane, "gjc");
    const firstProcess = await gjcProcess(firstPane);
    const secondProcess = await gjcProcess(secondPane);
    expect(firstProcess.pid).not.toBe(secondProcess.pid);

    const timestamp = Date.now();
    writeFileSync(indexPath,
      signedSdkIndexRow(1, "host_registered", firstSession, firstProcess.pid, timestamp)
      + signedSdkIndexRow(2, "host_registered", secondSession, secondProcess.pid, timestamp + 1));
    const paths = { [firstSession]: firstPath, [secondSession]: secondPath, [freshSession]: freshPath };
    writeRegistry([
      sdkRow(firstProcess.pid, home, firstSession),
      sdkRow(secondProcess.pid, home, secondSession),
    ], paths);

    expect(await gjcTranscriptPath(firstPane, home, home)).toBe(firstPath);
    expect(readFileSync(callsPath, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
    expect(await gjcTranscriptPath(secondPane, home, home)).toBe(secondPath);
    expect(readFileSync(callsPath, "utf8").split("\n").filter(Boolean)).toHaveLength(4);

    let indexSeq = 2;
    for (let wave = 1; wave <= 3; wave += 1) {
      const heartbeatSeq = ++indexSeq;
      const heartbeatPid = 900_000 + heartbeatSeq;
      appendFileSync(indexPath, signedSdkIndexRow(
        heartbeatSeq,
        "host_heartbeat",
        `unrelated-heartbeat-${heartbeatSeq}`,
        heartbeatPid,
        timestamp + heartbeatSeq,
      ));
      expect(await gjcTranscriptPath(firstPane, home, home)).toBe(firstPath);
      expect(await gjcTranscriptPath(secondPane, home, home)).toBe(secondPath);
      expect(readFileSync(callsPath, "utf8").split("\n").filter(Boolean)).toHaveLength(4);
    }

    writeRegistry([
      sdkRow(firstProcess.pid, home, freshSession),
      sdkRow(secondProcess.pid, home, secondSession),
    ], paths);
    const registeredSeq = ++indexSeq;
    appendFileSync(indexPath, signedSdkIndexRow(
      registeredSeq,
      "host_registered",
      freshSession,
      firstProcess.pid,
      timestamp + registeredSeq,
    ));
    expect(await gjcTranscriptPath(firstPane, home, home)).toBe(freshPath);
    expect(readFileSync(callsPath, "utf8").split("\n").filter(Boolean)).toHaveLength(6);
  } finally {
    forgetTranscriptState();
    rmSync(indexDir, { recursive: true, force: true });
    rmSync(callsPath, { force: true });
  }
}), 15_000);

it("SDK maps same-cwd panes by exact GJC PID despite identical answers, titles, and mtimes", async () => withSdkFixture(async () => {
  const a = join(dir, "same-answer-a.jsonl"), b = join(dir, "same-answer-b.jsonl");
  writeFileSync(a, record(home, "same", "same-answer-a"));
  writeFileSync(b, record(home, "same", "same-answer-b"));
  const first = await pane([dir], "same"), second = await pane([dir], "same");
  await waitForScreen(first, "same");
  await waitForScreen(second, "same");
  const firstProcess = await gjcProcess(first), secondProcess = await gjcProcess(second);
  expect(firstProcess.pid).not.toBe(secondProcess.pid);
  const sameTime = new Date(Date.now() - 60_000);
  utimesSync(a, sameTime, sameTime);
  utimesSync(b, sameTime, sameTime);
  writeRegistry([
    sdkRow(firstProcess.pid, home, "same-answer-a"),
    sdkRow(secondProcess.pid, home, "same-answer-b"),
  ], { "same-answer-a": a, "same-answer-b": b });

  expect(await gjcTranscriptPath(first, home, home)).toBe(a);
  expect(await gjcTranscriptPath(second, home, home)).toBe(b);
  await expectConversation(first, "same");
  await expectConversation(second, "same");
}));

it("SDK follows /new or resume when the same GJC PID changes from A to B without changing its one-word screen", async () => withSdkFixture(async () => {
  const a = join(dir, "resume-a.jsonl"), b = join(dir, "resume-b.jsonl");
  writeFileSync(a, record(home, "A", "resume-a"));
  writeFileSync(b, record(home, "B", "resume-b"));
  const id = await pane([dir], "A");
  await waitForScreen(id, "A");
  const { pid } = await gjcProcess(id);
  await setAgent(id, "gjc");
  writeRegistry([sdkRow(pid, home, "resume-a")], { "resume-a": a, "resume-b": b });
  expect(await gjcTranscriptPath(id, home, home)).toBe(a);

  // The fixture SDK registry now reflects /new or resume; neither the PID nor the pane screen changes.
  writeRegistry([sdkRow(pid, home, "resume-b")], { "resume-a": a, "resume-b": b });
  expect((await paneRead({ paneId: id })).text).toContain("A");
  expect(await gjcTranscriptPath(id, home, home)).toBe(b);
  await expectConversation(id, "B");
}));

it("conversation API distinguishes a temporary SDK failure from a replaced or missing session", async () => withSdkFixture(async () => {
  const a = join(dir, "transient-a.jsonl"), b = join(dir, "transient-b.jsonl");
  writeFileSync(a, record(home, "Original session answer", "transient-a"));
  writeFileSync(b, record(home, "Replacement session answer", "transient-b"));
  const id = await pane([dir]);
  const { pid } = await gjcProcess(id);
  await setAgent(id, "gjc");
  const row = sdkRow(pid, home, "transient-a");
  const paths = { "transient-a": a, "transient-b": b };
  writeRegistry([row], paths);
  const app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(home, "transient-api-state") });
  const url = `http://127.0.0.1:${app.port}/api/pane/conversation?pane_id=${encodeURIComponent(id)}`;
  try {
    const first = await fetch(url);
    expect(first.status).toBe(200);
    expect((await first.json()).turns[0].parts[0].text).toBe("Original session answer");

    writeRegistry([row], paths, "timeout");
    const timeout = await fetch(url);
    expect(timeout.status).toBe(504);
    expect(await timeout.json()).toMatchObject({ error: { code: "gjc_sdk_timeout" } });

    // a gjc that fails outright (not installed, too old, broker down) does not clear by
    // retrying: it keeps the terminal fallback it had before
    writeRegistry([row], paths, "unavailable");
    const unavailable = await fetch(url);
    expect(unavailable.status).toBe(200);
    expect(await unavailable.json()).toMatchObject({ source: "scrollback" });

    writeRegistry([row], paths);
    const recovered = await fetch(url);
    expect(recovered.status).toBe(200);
    expect((await recovered.json()).turns[0].parts[0].text).toBe("Original session answer");

    writeRegistry([sdkRow(pid, home, "transient-b")], paths);
    const replaced = await fetch(url);
    expect(replaced.status).toBe(200);
    expect((await replaced.json()).turns[0].parts[0].text).toBe("Replacement session answer");

    writeRegistry([], paths);
    const missing = await fetch(url);
    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({ source: "scrollback", turns: [] });
  } finally {
    app.stop();
  }
}));

it("SDK scopes discovery so unrelated retired history cannot exhaust the pane's page budget", async () => withSdkFixture(async () => {
  const a = join(dir, "scoped-a.jsonl");
  writeFileSync(a, record(home, "scoped answer", "scoped-a"));
  const id = await pane([dir]);
  const { pid } = await gjcProcess(id);
  const otherCwd = join(home, "unrelated-project");
  mkdirSync(otherCwd);
  const retired = Array.from({ length: 801 }, (_, index) =>
    sdkRow(900_000 + index, otherCwd, `old-${index}`, { live: false }));
  writeRegistry([...retired, sdkRow(pid, home, "scoped-a")], { "scoped-a": a });
  expect(await gjcTranscriptPath(id, home, home)).toBe(a);
}));

it("SDK GJC identity overrides stale Codex session metadata", async () => withSdkFixture(async () => {
  const a = join(dir, "stale-codex-a.jsonl");
  writeFileSync(a, record(home, "SDK GJC answer", "stale-codex-a"));
  const id = await pane([dir], "SDK GJC answer");
  const { pid } = await gjcProcess(id);
  await herdrRpc("pane.report_agent_session", {
    pane_id: id,
    source: "herdr:codex",
    agent: "codex",
    seq: Date.now(),
    agent_session_id: "01a0f16d-c20a-7a02-a880-e89b68155802",
  });
  const metadata = (await sessionSnapshot()).panes.find((item) => item.pane_id === id)!;
  expect(metadata.agent ?? null).toBeNull();
  expect(metadata.agent_session?.agent).toBe("codex");
  writeRegistry([sdkRow(pid, home, "stale-codex-a")], { "stale-codex-a": a });

  await expectConversation(id, "SDK GJC answer");
}));

async function expectSdkFailure(scenario: string): Promise<void> {
  await withSdkFixture(async () => {
    const a = join(dir, `failure-${scenario}-a.jsonl`), b = join(dir, `failure-${scenario}-b.jsonl`);
    const guessedAnswer = "This long screen answer would identify the neighboring transcript if screen matching were still used as a fallback.";
    writeFileSync(a, record(home, "SDK target", `failure-${scenario}-a`));
    writeFileSync(b, record(home, guessedAnswer, `failure-${scenario}-b`));
    const id = await pane([dir], guessedAnswer);
    await waitForScreen(id, guessedAnswer.slice(0, 40));
    const { pid } = await gjcProcess(id);
    await setAgent(id, "gjc");
    const target = sdkRow(pid, home, `failure-${scenario}-a`);
    const paths = { [`failure-${scenario}-a`]: a, [`failure-${scenario}-b`]: b };

    if (scenario === "unavailable") writeRegistry([target], paths, "unavailable");
    else if (scenario === "malformed") writeRegistry([target], paths, "malformed");
    else if (scenario === "ambiguous") writeRegistry([
      target,
      sdkRow(pid, home, `failure-${scenario}-b`),
    ], paths);
    else if (scenario === "stale") writeRegistry([sdkRow(pid, home, `failure-${scenario}-a`, { live: false })], paths);
    else writeRegistry([target]);

    await expect(paneConversation(id)).rejects.toBeInstanceOf(ConversationUnavailable);
  });
}

for (const scenario of ["unavailable", "malformed", "ambiguous", "stale", "omitted path"]) {
  it(`SDK ${scenario} identity fails closed instead of guessing from the pane screen`, async () => expectSdkFailure(scenario));
}

it("pane routing honors an actual named non-GJC agent even when a GJC process is present", async () => withSdkFixture(async () => {
  const a = join(dir, "named-non-gjc.jsonl");
  writeFileSync(a, record(home, "GJC must not take this pane", "named-non-gjc"));
  const id = await pane([dir], "GJC must not take this pane");
  const { pid } = await gjcProcess(id);
  await setAgent(id, "codex");
  writeRegistry([sdkRow(pid, home, "named-non-gjc")], { "named-non-gjc": a });

  expect((await sessionSnapshot()).panes.find((item) => item.pane_id === id)?.agent).toBe("codex");
  await expect(paneConversation(id)).rejects.toBeInstanceOf(ConversationUnavailable);
}));

it("SDK GJC resolution respects the process foreground cwd", async () => withSdkFixture(async () => {
  const cwd = join(home, "foreground-project");
  mkdirSync(cwd);
  const a = join(dir, "foreground-cwd.jsonl"), other = join(dir, "pane-shell-cwd.jsonl");
  writeFileSync(a, record(cwd, "foreground cwd answer", "foreground-cwd"));
  writeFileSync(other, record(home, "wrong pane cwd answer", "pane-shell-cwd"));
  const id = await pane([dir], "foreground cwd answer", cwd);
  const { pid } = await gjcProcess(id);
  await setAgent(id, "gjc");
  let metadata = (await sessionSnapshot()).panes.find((item) => item.pane_id === id)!;
  for (let attempt = 0; attempt < 100 && metadata.foreground_cwd !== cwd; attempt++) {
    await Bun.sleep(50);
    metadata = (await sessionSnapshot()).panes.find((item) => item.pane_id === id)!;
  }
  expect(metadata.cwd).toBe(home);
  expect(metadata.foreground_cwd).toBe(cwd);
  writeRegistry([sdkRow(pid, cwd, "foreground-cwd")], { "foreground-cwd": a });

  await expectConversation(id, "foreground cwd answer");
}));

it("starts the gjc this server found on its PATH, by absolute path, and waits until it runs in the pane", async () => withSdkFixture(async () => {
  const shell = async () => {
    const created = await workspaceCreate({ cwd: home, label: "herdr-web-ui-test-gjc-start" });
    workspaces.push(created.workspace.workspace_id);
    return created.root_pane.pane_id;
  };
  // A `gjc` executable in a directory with a space is on this process's PATH only; the pane shell never sees that PATH.
  const spacedBin = join(home, "agent bin");
  mkdirSync(spacedBin);
  const exe = join(spacedBin, "gjc");
  writeFileSync(exe, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`, { mode: 0o755 });
  const previousPath = process.env["PATH"];
  try {
    process.env["PATH"] = `${spacedBin}:${previousPath ?? ""}`;
    const id = await shell();
    await startShellAgent("gjc", id, [dir]);
    const info = await herdrRpc<{ process_info?: { foreground_processes?: { argv?: string[] }[] } }>("pane.process_info", { pane_id: id });
    expect(info.process_info?.foreground_processes?.find((candidate) => isGjcProcess(candidate.argv ?? []))?.argv?.slice(-1)).toEqual([dir]);
    process.env["PATH"] = "/nonexistent";
    const bare = await shell();
    await expect(startShellAgent("gjc", bare, [], { timeoutMs: 1500 })).rejects.toThrow("not on this server's PATH");
    expect((await paneRead({ paneId: bare })).text.replaceAll(home, "")).not.toContain("gjc");
  } finally {
    if (previousPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = previousPath;
  }
}));
