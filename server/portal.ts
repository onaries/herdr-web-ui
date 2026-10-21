/**
 * Portal (github.com/gosuda/portal-tunnel): an optional public HTTPS address for this server,
 * started and stopped from Settings → Phone & devices with the `portal` already on this PC; the
 * app never installs it. Tailscale stays the private route and is only ever read (tailscale.ts).
 * Whatever a request asks, the guide's rules for a public proxy hold (docs/guide.md, Behind a
 * reverse proxy):
 *
 * - no address without a token, and none while HERDR_WEB_TAILSCALE_SERVE_ONLY says tailscale serve
 *   is the only way in, not even one an earlier server left running;
 * - routed mode, which keeps the browser's Host and sends X-Forwarded-For and
 *   X-Forwarded-Proto: https, and drops a visitor's Tailscale-User-Login;
 * - one relay the user picked, discovery off, hidden from the relay's list; the identity file kept
 *   here holds the name, and with it the address, across restarts;
 * - only the relay's origin comes from the request, and Portal gets none of this server's
 *   environment beyond what running and reaching the relay need: the token stays here.
 *
 * Portal keeps retrying a relay it cannot use and never exits for it (v2.6.1), so the relay's
 * version is asked first and readiness has a deadline of its own.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PortalStatus } from "../shared/protocol.ts";
import { errorResponse, isJsonObject, jsonResponse, setRequestRoute } from "./http.ts";
import { chunksOf } from "./remote-bundle.ts";
import { updateRequestAllowed } from "./update-api.ts";
import { windowsArgv, windowsProcessTable } from "./windows-processes.ts";

/** the first release with `--strip-request-header` and an address tied to the identity */
const PORTAL_VERSION = "v2.6.1";
/** a relay that answers but will not take the tunnel is only ever retried, never refused */
const READY_TIMEOUT_MS = 60_000;
/** Portal unregisters from the relay on SIGTERM; one still running after this is killed, within the 6 s the supervisor gives this server to stop */
const STOP_GRACE_MS = 4_000;
const PROCESS_POLL_MS = 100;
const KILL_CONFIRM_MS = 1_000;
const VERSION_TIMEOUT_MS = 2_500;
/** the panel polls the status; `portal version` is a process each time */
const VERSION_CACHE_MS = 5_000;
const RELAY_TIMEOUT_MS = 5_000;
/** what is still in Portal's pipes when it exits: its last words */
const PIPE_GRACE_MS = 250;
/** Portal's last words kept for the panel */
const OUTPUT_LINES = 30;
/** what Portal may keep of this server's environment: enough to run and to reach the relay */
const PORTAL_ENV = ["PATH", "HOME", "USERPROFILE", "SystemRoot", "TMPDIR", "TEMP", "TMP", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"];

type Phase = PortalStatus["phase"];
type Child = ReturnType<typeof Bun.spawn>;
interface Guards {
  /** HERDR_WEB_TOKEN is set */
  tokenSet: boolean;
  /** HERDR_WEB_TAILSCALE_SERVE_ONLY: tailscale serve is declared the only way in */
  serveOnly: boolean;
}
interface StartRequest extends Guards {
  relay: string;
  /** this server's port, Portal's upstream */
  port: number;
}
interface SavedState {
  enabled: boolean;
  relay: string | null;
  /** the server that started it: another one on this state directory leaves its Portal alone */
  port: number | null;
  /** the Portal last started, so the next server can stop it if it is still running */
  pid: number | null;
}

export interface PortalServiceOptions {
  /** Portal's identity and on/off choice live in its portal/ */
  stateDir: string;
  /** the portal to run; unset, `portal` from PATH, read at each start */
  bin?: string;
  fetch?: typeof fetch;
  /** READY_TIMEOUT_MS and STOP_GRACE_MS; tests shorten them */
  readyTimeoutMs?: number;
  stopGraceMs?: number;
}

/** "v2.6.1" → [2, 6, 1]; null for anything else. */
function parseVersion(text: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function atLeast(version: string, minimum: string): boolean {
  const have = parseVersion(version);
  const need = parseVersion(minimum);
  if (have === null || need === null) return false;
  for (let i = 0; i < 3; i++) if (have[i] !== need[i]) return have[i]! > need[i]!;
  return true;
}

/** A relay as the user gave it, as an https origin; null for anything with a path, a query, credentials or a second host. */
export function relayOrigin(input: unknown): string | null {
  if (typeof input !== "string" || input.trim() === "") return null;
  const text = input.trim();
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
  // `--relays` takes a comma-separated list, which a URL's host does not refuse
  return /^[a-z0-9.-]+$/i.test(url.hostname) ? url.origin : null;
}

/** The address on Portal's "service ready at" line, without the default port; null for any other line. */
export function readyUrl(line: string): string | null {
  const match = /service ready at (https:\/\/\S+)/.exec(line);
  if (!match) return null;
  try { return new URL(match[1]!).origin; } catch { return null; }
}

function blockedBy({ tokenSet, serveOnly }: Guards): PortalStatus["blocked"] {
  if (!tokenSet) return "token_required";
  if (serveOnly) return "serve_only";
  return null;
}

function portalEnv(): Record<string, string> {
  const env: Record<string, string> = { NO_COLOR: "1" };
  for (const name of PORTAL_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function processErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function processPresence(pid: number): "alive" | "gone" | "unknown" {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const end = stat.lastIndexOf(")");
      // A zombie still has a PID but cannot be running or signaled.
      if (end >= 0 && stat.slice(end + 1).trimStart().startsWith("Z")) return "gone";
    } catch { /* process.kill below distinguishes a gone pid from an unreadable one */ }
  }
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = processErrorCode(error);
    if (code === "ESRCH") return "gone";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

function portalExecutable(value: string | undefined): boolean {
  return /^(?:portal)(?:\.exe)?$/i.test(value?.split(/[\\/]/).at(-1) ?? "");
}

function scriptInterpreter(value: string | undefined): boolean {
  return /^(?:sh|bash|dash|zsh|ksh|ash)(?:\.exe)?$/i.test(value?.split(/[\\/]/).at(-1) ?? "");
}

/** `ps` has no argv mode on every supported Unix, so parse its quoted command conservatively. */
function splitCommandLine(command: string): string[] | null {
  const args: string[] = [];
  let arg = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;
  for (const char of command.trim()) {
    if (escaped) {
      arg += char;
      escaped = false;
      started = true;
    } else if (char === "\\") {
      escaped = true;
      started = true;
    } else if (quote !== null) {
      if (char === quote) quote = null;
      else arg += char;
      started = true;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        args.push(arg);
        arg = "";
        started = false;
      }
    } else {
      arg += char;
      started = true;
    }
  }
  if (quote !== null || escaped) return null;
  if (started) args.push(arg);
  return args.length > 0 ? args : null;
}

async function processArgv(pid: number, timeoutMs: number): Promise<string[] | null> {
  try {
    if (process.platform === "win32") {
      const row = (await windowsProcessTable(timeoutMs)).find((entry) => entry.pid === pid);
      if (row?.commandLine === null || row?.commandLine === undefined) return null;
      const argv = windowsArgv(row.commandLine);
      if (argv.length === 0) return null;
      if (row.path !== null) argv[0] = row.path;
      return argv;
    }
    if (process.platform === "linux") {
      const text = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      const argv = text.split("\0");
      if (argv.at(-1) === "") argv.pop();
      return argv.length > 0 && argv[0] !== "" ? argv : null;
    }
    const ps = Bun.spawn(["ps", "-ww", "-o", "command=", "-p", String(pid)], {
      stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: timeoutMs, killSignal: "SIGKILL",
    });
    const [code, text] = await Promise.all([ps.exited, new Response(ps.stdout as ReadableStream<Uint8Array>).text()]);
    return code === 0 ? splitCommandLine(text) : null;
  } catch { return null; }
}

function isPortalExpose(argv: readonly string[], identityPath: string): boolean {
  const direct = portalExecutable(argv[0]) && argv[1] === "expose";
  // A shebang script (including the shell stand-in used by tests) appears as interpreter, script, argv.
  const script = scriptInterpreter(argv[0]) && portalExecutable(argv[1]) && argv[2] === "expose";
  if (!direct && !script) return false;
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === "--identity-path" && argv[i + 1] === identityPath) return true;
  }
  return false;
}

/** Portal's last warning or error, else its last line, for a failure that has no words of its own. */
function lastWords(lines: readonly string[]): string {
  const line = [...lines].reverse().find((candidate) => /\b(WRN|ERR|FTL)\b/.test(candidate)) ?? lines.at(-1);
  return line === undefined ? "" : ` Portal said: ${line}`;
}

async function readVersion(bin: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([bin, "version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: portalEnv(), windowsHide: true, timeout: VERSION_TIMEOUT_MS, killSignal: "SIGKILL" });
    const [text, code] = await Promise.all([new Response(proc.stdout as ReadableStream<Uint8Array>).text(), proc.exited]);
    const tag = /\bv?\d+\.\d+\.\d+\S*/.exec(text)?.[0];
    return code === 0 && tag !== undefined ? tag : null;
  } catch { return null; }
}

export class PortalService {
  private phase: Phase = "idle";
  private relay: string | null = null;
  private url: string | null = null;
  private error: string | null = null;
  private lines: string[] = [];
  private child: Child | null = null;
  /** a start between its request and its process, or the boot's cleanup: one at a time */
  private launching = false;
  /** invalidates starts/resumes that are still waiting on a version, relay or old process */
  private operation = 0;
  /** shutdown is final for this server instance, even if a start has not spawned yet */
  private shutdownRequested = false;
  private cleanup: Promise<void> | null = null;
  /** a child asked to end, once: its exit is no failure */
  private ending: Child | null = null;
  private versionRead: { at: number; bin: string | null; value: Promise<string | null> } | null = null;
  /** the port this service represents; a service for another port must not change the owner's saved choice */
  private serverPort: number | null = null;
  private readonly dir: string;

  constructor(private readonly options: PortalServiceOptions) {
    this.dir = join(options.stateDir, "portal");
  }

  private get identityPath(): string { return join(this.dir, "identity.json"); }
  private get statePath(): string { return join(this.dir, "state.json"); }

  private bin(): string | null {
    return this.options.bin ?? Bun.which("portal");
  }

  private version(fresh = false): Promise<string | null> {
    const bin = this.bin();
    const now = Date.now();
    if (!fresh && this.versionRead && this.versionRead.bin === bin && now - this.versionRead.at < VERSION_CACHE_MS) return this.versionRead.value;
    const value = bin === null ? Promise.resolve(null) : readVersion(bin);
    this.versionRead = { at: now, bin, value };
    return value;
  }

  async status(guards: Guards): Promise<PortalStatus> {
    const version = await this.version();
    return {
      supported: true,
      version,
      min_version: PORTAL_VERSION,
      usable: version !== null && atLeast(version, PORTAL_VERSION),
      phase: this.phase,
      relay: this.relay,
      url: this.url,
      blocked: blockedBy(guards),
      error: this.error,
      output: this.lines.length > 0 ? this.lines.join("\n") : null,
    };
  }

  /**
   * At the server's start. A Portal the last server left running is stopped whatever comes next,
   * so a server that may not open the address does not keep one open; an address that was on
   * comes back, so an app update does not take it down for good.
   */
  async resume(request: Omit<StartRequest, "relay">): Promise<void> {
    if (this.shutdownRequested || this.child !== null || this.launching) return;
    const saved = this.saved();
    this.relay = saved.relay;
    this.serverPort = request.port;
    // a server on another port shares this state directory: what runs is its own
    if (saved.port !== null && saved.port !== request.port) return;
    const operation = ++this.operation;
    this.launching = true;
    try { await this.cleanLeftover(saved.pid); } finally { this.launching = false; }
    if (this.shutdownRequested || this.operation !== operation) return;
    if (saved.enabled && saved.relay !== null && blockedBy(request) === null) this.start({ ...request, relay: saved.relay });
  }

  start(request: StartRequest): "started" | "busy" | "token_required" | "serve_only" | "state_in_use" {
    const blocked = blockedBy(request);
    if (blocked !== null) return blocked;
    if (this.shutdownRequested || this.child !== null || this.launching) return "busy";
    const saved = this.saved();
    this.serverPort = request.port;
    if (saved.port !== null && saved.port !== request.port) return "state_in_use";
    this.phase = "starting";
    this.relay = request.relay;
    this.url = null;
    this.error = null;
    this.lines = [];
    this.launching = true;
    const operation = ++this.operation;
    void this.launch(request, operation)
      // a start stopped meanwhile failed for no one
      .catch((error: unknown) => { if (this.isCurrentStart(operation)) this.fail(messageOf(error)); })
      .finally(() => { this.launching = false; });
    return "started";
  }

  /** Takes this server's address down and remembers that it is off when this server owns the saved state. */
  stop(): void {
    this.operation++;
    this.url = null;
    this.error = null;
    if (this.child !== null) {
      this.phase = "stopping";
      this.end(this.child);
    } else if (this.phase === "starting" || this.phase === "error") {
      // a start still asking its relay ends there
      this.phase = "idle";
    }
    const saved = this.saved();
    if (saved.port === null || saved.port === this.serverPort) this.save({ enabled: false });
  }

  /** The server is going away: Portal goes with it, and the saved choice stays for the next server. Settles once Portal has exited. */
  shutdown(): Promise<void> {
    this.shutdownRequested = true;
    this.operation++;
    // resume already fails the startup gate closed; a cleanup error must not strand shutdown.
    const cleanup = this.cleanup?.catch((error: unknown) => {
      console.error(`Portal cleanup failed during shutdown: ${messageOf(error)}`);
    });
    const child = this.child;
    if (child === null) {
      if (this.phase === "starting") this.phase = "idle";
      return cleanup ?? Promise.resolve();
    }
    this.end(child);
    return Promise.all([child.exited, cleanup]).then(() => undefined);
  }

  private end(child: Child): void {
    if (this.ending === child) return;
    this.ending = child;
    child.kill("SIGTERM");
    const killer = setTimeout(() => child.kill("SIGKILL"), this.options.stopGraceMs ?? STOP_GRACE_MS);
    void child.exited.finally(() => clearTimeout(killer));
  }

  private fail(text: string): void {
    this.phase = "error";
    this.error = text;
    this.url = null;
    if (this.child !== null) this.end(this.child);
  }

  private isCurrentStart(operation: number): boolean {
    return !this.shutdownRequested && this.operation === operation && this.phase === "starting";
  }

  private async launch({ relay, port }: StartRequest, operation: number): Promise<void> {
    const bin = this.bin();
    const version = bin === null ? null : await this.version(true);
    if (!this.isCurrentStart(operation)) return;
    if (bin === null || version === null) throw new Error("Portal is not installed on this PC.");
    if (!atLeast(version, PORTAL_VERSION)) throw new Error(`This PC has Portal ${version}; the app needs ${PORTAL_VERSION} or later.`);
    await this.checkRelay(relay);
    if (!this.isCurrentStart(operation)) return;
    // another server of this app on this identity: two Portals keep taking the address from each other
    await this.cleanLeftover(this.saved().pid);
    if (!this.isCurrentStart(operation)) return;
    // Portal needs its identity parent before it starts; it contains the saved address.
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const child = Bun.spawn([
      bin, "expose",
      "--http-route", `/=${port}`,
      "--strip-request-header", "Tailscale-User-Login",
      // a name counts only when the identity file is created; later runs keep the saved one
      "--name", `herdr-${randomBytes(8).toString("hex")}`,
      "--identity-path", this.identityPath,
      "--relays", relay, "--discovery=false",
      "--hide",
    ], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: portalEnv(), windowsHide: true });
    this.child = child;
    const readyTimeoutMs = this.options.readyTimeoutMs ?? READY_TIMEOUT_MS;
    const deadline = setTimeout(() => {
      if (this.child === child && this.phase === "starting") this.fail(`${relay} did not take the tunnel within ${Math.round(readyTimeoutMs / 1000)} seconds.${lastWords(this.lines)}`);
    }, readyTimeoutMs);
    const output = Promise.all([this.follow(child.stdout as ReadableStream<Uint8Array>, child), this.follow(child.stderr as ReadableStream<Uint8Array>, child)]);
    void child.exited.then(async (code) => {
      clearTimeout(deadline);
      await Promise.race([output, Bun.sleep(PIPE_GRACE_MS)]);
      if (this.child !== child) return;
      this.child = null;
      this.url = null;
      if (this.ending === child) {
        this.ending = null;
        if (this.phase !== "error") this.phase = "idle";
        return;
      }
      this.phase = "error";
      this.error = `Portal stopped on its own (exit ${code}).${lastWords(this.lines)}`;
    });
    // a Portal whose pid cannot be kept is one the next server could not stop
    this.save({ enabled: true, relay, port, pid: child.pid });
  }

  /** Portal writes one event a line: the address once a relay takes the tunnel, and why it gave up on one. */
  private async follow(stream: ReadableStream<Uint8Array>, child: Child): Promise<void> {
    const decoder = new TextDecoder();
    let pending = "";
    try {
      for await (const chunk of chunksOf(stream)) {
        pending += decoder.decode(chunk, { stream: true });
        for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
          this.line(pending.slice(0, end), child);
          pending = pending.slice(end + 1);
        }
      }
      this.line(pending + decoder.decode(), child);
    } catch { /* the pipe closes with the process */ }
  }

  private line(raw: string, child: Child): void {
    // NO_COLOR is set; a terminal's codes would be no use here either way
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (line === "" || this.child !== child) return;
    this.lines = [...this.lines, line].slice(-OUTPUT_LINES);
    const url = readyUrl(line);
    if (url !== null) {
      if (this.phase === "starting" || this.phase === "running") {
        this.url = url;
        this.phase = "running";
      }
      return;
    }
    // the relay refused for good (a name it will not take, an incompatible relay): the process would stay up serving nothing
    if (line.includes("relay operation failed permanently") && (this.phase === "starting" || this.phase === "running")) this.fail(line);
  }

  /** A relay Portal cannot use is retried for good and silently: ask the relay first. */
  private async checkRelay(relay: string): Promise<void> {
    let body: unknown;
    try {
      const response = await (this.options.fetch ?? fetch)(`${relay}/sdk/domain`, { signal: AbortSignal.timeout(RELAY_TIMEOUT_MS), redirect: "error" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      body = await response.json();
    } catch (error) {
      throw new Error(`${relay} did not answer as a Portal relay (${messageOf(error)}).`);
    }
    const data = isJsonObject(body) && isJsonObject(body["data"]) ? body["data"] : {};
    const release = typeof data["release_version"] === "string" ? data["release_version"] : "an unknown version";
    if (!atLeast(release, PORTAL_VERSION)) throw new Error(`${relay} runs Portal ${release}; the tunnel needs a relay on ${PORTAL_VERSION} or later.`);
  }

  /**
   * A Portal on this identity that this server did not start: one a server killed outright left
   * running, or one another server of this app runs. A pid outlives its process, so only the one
   * recorded here, and only while its command line is `portal expose` on this identity, is stopped.
   */
  private async cleanLeftover(pid: number | null): Promise<void> {
    const cleanup = this.stopLeftover(pid);
    this.cleanup = cleanup;
    try { await cleanup; } finally {
      if (this.cleanup === cleanup) this.cleanup = null;
    }
  }

  private async stopLeftover(pid: number | null): Promise<void> {
    if (pid === null || pid === this.child?.pid) return;
    // All inspection and termination fits inside the supervisor's six-second shutdown budget.
    const deadline = Date.now() + STOP_GRACE_MS + KILL_CONFIRM_MS;
    const argv = await this.identifyProcess(pid, deadline);
    if (argv === null || !isPortalExpose(argv, this.identityPath)) return;
    if (!this.signalLeftover(pid, "SIGTERM")) return;
    const queryBudget = process.platform === "linux" ? 0 : VERSION_TIMEOUT_MS;
    const graceDeadline = Math.min(Date.now() + (this.options.stopGraceMs ?? STOP_GRACE_MS), deadline - queryBudget - KILL_CONFIRM_MS);
    while (Date.now() < graceDeadline) {
      await Bun.sleep(Math.min(PROCESS_POLL_MS, graceDeadline - Date.now()));
      if (this.processIsGone(pid)) return;
    }
    // The pid may have been recycled while Portal was given its grace period.
    const currentArgv = await this.identifyProcess(pid, deadline);
    if (currentArgv === null || !isPortalExpose(currentArgv, this.identityPath)) return;
    if (!this.signalLeftover(pid, "SIGKILL")) return;
    const killDeadline = Math.min(Date.now() + KILL_CONFIRM_MS, deadline);
    for (;;) {
      if (this.processIsGone(pid)) return;
      if (Date.now() >= killDeadline) throw new Error(`Portal process ${pid} did not exit after SIGKILL.`);
      await Bun.sleep(Math.min(PROCESS_POLL_MS, killDeadline - Date.now()));
    }
  }

  private processArgv(pid: number, timeoutMs: number): Promise<string[] | null> {
    return processArgv(pid, timeoutMs);
  }

  private async identifyProcess(pid: number, deadline: number): Promise<string[] | null> {
    if (this.processIsGone(pid)) return null;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Timed out inspecting recorded Portal process ${pid}.`);
    const argv = await this.processArgv(pid, Math.min(VERSION_TIMEOUT_MS, remaining));
    if (argv !== null) return argv;
    if (this.processIsGone(pid)) return null;
    throw new Error(`Could not verify the identity of recorded Portal process ${pid}.`);
  }

  private processIsGone(pid: number): boolean {
    const presence = processPresence(pid);
    if (presence === "unknown") throw new Error(`Could not determine whether recorded Portal process ${pid} is running.`);
    return presence === "gone";
  }

  private signalLeftover(pid: number, signal: NodeJS.Signals): boolean {
    try {
      process.kill(pid, signal);
      return true;
    } catch (error) {
      if (processErrorCode(error) === "ESRCH") return false;
      throw new Error(`Could not send ${signal} to recorded Portal process ${pid} (${messageOf(error)}).`);
    }
  }

  private saved(): SavedState {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.statePath, "utf8"));
    } catch (error) {
      if (processErrorCode(error) === "ENOENT") return { enabled: false, relay: null, port: null, pid: null };
      throw new Error("Could not read saved Portal state; refusing to assume its tunnel is stopped.", { cause: error });
    }
    if (!isJsonObject(value)) throw new Error("Saved Portal state is invalid.");
    const { enabled, relay, port, pid } = value;
    const origin = relayOrigin(relay);
    if (typeof enabled !== "boolean"
      || (relay !== null && origin === null)
      || (port !== null && !(typeof port === "number" && Number.isSafeInteger(port) && port > 0 && port <= 65535))
      || (pid !== null && !(typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0))
      || (enabled && (origin === null || port === null || pid === null))) {
      throw new Error("Saved Portal state is invalid.");
    }
    return { enabled, relay: origin, port: port as number | null, pid: pid as number | null };
  }

  /** at once, not awaited: a stop and a start's own save never interleave */
  private save(change: Partial<SavedState>): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const temp = `${this.statePath}.tmp-${process.pid}`;
    writeFileSync(temp, JSON.stringify({ ...this.saved(), ...change }), { mode: 0o600 });
    renameSync(temp, this.statePath);
  }
}

const NO_PORTAL: PortalStatus = { supported: false, version: null, min_version: PORTAL_VERSION, usable: false, phase: "idle", relay: null, url: null, blocked: null, error: null, output: null };

/** /api/portal and its actions. What this server is (its port, token and serve-only setting) comes from index.ts. */
export async function handlePortalRequest(request: Request, pathname: string, portal: PortalService | undefined, context: Omit<StartRequest, "relay">): Promise<Response> {
  const reply = (body: unknown, code = 200) => jsonResponse(body, code, { "cache-control": "no-store" });
  const fail = (code: string, message: string, http: number) => reply({ error: { code, message } }, http);
  if (pathname === "/api/portal" && request.method === "GET") {
    setRequestRoute(pathname);
    // a server started without the service (tests, an embedding) offers nothing
    return reply(portal ? await portal.status(context) : NO_PORTAL);
  }
  const action = pathname.slice("/api/portal/".length);
  if (request.method !== "POST" || (action !== "start" && action !== "stop")) {
    return fail("method_not_allowed", "Use GET /api/portal, or POST /api/portal/start or /stop", 405);
  }
  setRequestRoute(action === "start" ? "/api/portal/start" : "/api/portal/stop");
  if (!updateRequestAllowed(request)) return fail("invalid_portal_request", "Use the Portal controls from this app.", 403);
  if (!portal) return fail("portal_unsupported", "This server offers no Portal.", 409);
  if (action === "stop") {
    try { portal.stop(); } catch (error) { return errorResponse(error); }
    return reply({ accepted: true }, 202);
  }
  let body: unknown = null;
  try { body = await request.json(); } catch { /* checked below */ }
  const relay = relayOrigin(isJsonObject(body) ? body["relay"] : undefined);
  if (relay === null) return fail("invalid_relay", "Give the relay as an https address, such as https://relay.example.com.", 400);
  let started: ReturnType<PortalService["start"]>;
  try { started = portal.start({ ...context, relay }); } catch (error) { return errorResponse(error); }
  if (started === "token_required") return fail("token_required", "Set HERDR_WEB_TOKEN and restart the app before you start Portal: anyone on the internet can open its address.", 409);
  if (started === "serve_only") return fail("serve_only", "Turn off HERDR_WEB_TAILSCALE_SERVE_ONLY and restart the app before you start Portal: it says tailscale serve is the only way in.", 409);
  if (started === "busy") return fail("portal_busy", "Portal is busy; try again once it is idle.", 409);
  if (started === "state_in_use") return fail("portal_state_in_use", "Another server owns this Portal state directory. Give this server its own HERDR_WEB_STATE_DIR.", 409);
  return reply({ accepted: true }, 202);
}
