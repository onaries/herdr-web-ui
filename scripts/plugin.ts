/**
 * herdr plugin lifecycle for the web UI.
 *
 * herdr's startup hooks are one-shot initialization commands, not supervised
 * daemons (https://herdr.dev/docs/plugins/), so this script owns the process:
 * `start` detaches the server and records its pid under HERDR_PLUGIN_STATE_DIR,
 * `stop` takes it down, `status` reports, `pair` prints a pairing code for another device, `phone`
 * publishes the app to the user's tailnet and prints its address as a QR code. Start is idempotent — a server that is
 * already answering on the port is left alone, which is what makes it safe as
 * both a startup hook and a hand-invoked action.
 *
 * The port is settled here, before the server is spawned: with no PORT set, a default that cannot
 * be opened gives way to the next one that can (scripts/plugin-port.ts), and that choice is kept
 * for later starts and for `status`, `pair` and `phone`.
 *
 * Two pieces of herdr's runtime environment have to be translated:
 * - herdr injects HERDR_SOCKET_PATH; the server reads HERDR_SOCKET. Without the
 *   mapping a named session's plugin would talk to the default socket.
 * - plugin commands inherit herdr's environment, not the user's shell, so the
 *   token and any overrides are read from `env` and `.env` in HERDR_PLUGIN_CONFIG_DIR.
 */

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, join, resolve } from "node:path";

import qrcode from "qrcode-generator";

import { DEFAULT_PORT } from "../shared/protocol.ts";
import type { RemoteAccess } from "../shared/protocol.ts";
import { canBind, FALLBACK_PORTS, freePort, savedPort } from "./plugin-port.ts";
import { activePluginScript } from "./plugin-runtime.ts";
import { parseTailscale, parseTailscaleIp, parseTailscaleOwner, readTailscale, tailscaleBinary } from "../server/tailscale.ts";
import { windowsArgv, windowsProcessTable } from "../server/windows-processes.ts";

/**
 * Read in this order, so `.env` wins: `env` is what this plugin read first, `.env` is what herdr's
 * plugin docs suggest, and a user who edits `.env` from those docs must not be overridden by an old `env`.
 * Declared before CONFIG_DIR, whose lookup uses it.
 */
const ENV_FILES = ["env", ".env"];
const ROOT = resolve(process.env["HERDR_PLUGIN_ROOT"] ?? join(import.meta.dir, ".."));
const STATE_DIR = process.env["HERDR_PLUGIN_STATE_DIR"] ?? join(homedir(), ".local", "state", "herdr-web-ui");
const CONFIG_DIR = process.env["HERDR_PLUGIN_CONFIG_DIR"] ?? herdrConfigDir() ?? join(homedir(), ".config", "herdr-web-ui");
const PID_FILE = join(STATE_DIR, "server.pid");
const LOG_FILE = join(STATE_DIR, "server.log");
/** the server needs a moment to bind and open its first herdr connection */
const READY_TIMEOUT_MS = 20_000;
/** the supervisor gives its bridge 6 s to exit before it kills it */
const STOP_TIMEOUT_MS = 15_000;
/** how long a killed server gets to disappear before `stop` reports that it could not stop it */
const KILL_WAIT_MS = 3_000;
/** `tailscale serve` waits while the user turns HTTPS on for the tailnet at the link it prints */
const SERVE_TIMEOUT_MS = 180_000;
/** how to come back to `phone` once Tailscale is set up: an action's output goes to herdr's log, not a terminal */
const PHONE_AGAIN = platform() === "win32"
  ? "irm https://herdrweb.dev/install.ps1 | iex"
  : "curl -fsSL https://herdrweb.dev/install.sh | sh";

/**
 * Run by hand (`pair` on a headless PC), herdr's env is not there to name the config dir:
 * ask herdr for it, so the PORT, HOST and token the plugin runs with are the ones used.
 */
function herdrConfigDir(): string | null {
  const herdr = Bun.which("herdr");
  if (herdr === null) return null;
  try {
    const result = Bun.spawnSync([herdr, "plugin", "config-dir", "devswha.herdr-web-ui"], { windowsHide: true, stdout: "pipe", stderr: "ignore", timeout: 3000 });
    const dir = result.exitCode === 0 ? result.stdout.toString().trim() : "";
    return dir !== "" && ENV_FILES.some((name) => existsSync(join(dir, name))) ? dir : null;
  } catch {
    return null;
  }
}

/** `KEY=value` lines of one settings file */
function readEnvFile(file: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return vars;
}

/** the settings files in the plugin's config dir: the token lives here, not in herdr's env */
const CONFIG_FILES = ENV_FILES.map((name) => join(CONFIG_DIR, name)).filter((file) => existsSync(file));
const fileVars = CONFIG_FILES.map(readEnvFile);
/** keys both files set to different values: `.env` wins, which someone editing `env` would not expect */
const shadowed = fileVars.length === 2 ? Object.keys(fileVars[0]!).filter((key) => key in fileVars[1]! && fileVars[0]![key] !== fileVars[1]![key]) : [];
const env = { ...process.env, ...Object.assign({}, ...fileVars) as Record<string, string> };
const PATH_KEY = platform() === "win32" ? Object.keys(env).sort().find(key => key.toLowerCase() === "path") ?? "PATH" : "PATH";
/** the app's own state, as the server finds it (server/update-state.ts): the same path with or without herdr's env */
const APP_STATE_DIR = env["HERDR_WEB_STATE_DIR"] || join(env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "herdr-web-ui");
/** the port a start took because the default could not be opened; absent while the default serves */
const PORT_FILE = join(APP_STATE_DIR, "plugin-port");
/** a PORT the user set is theirs: it is never swapped for another */
const portSet = (env["PORT"] ?? "") !== "";
let port = portSet ? Number(env["PORT"]) : savedPort(PORT_FILE) ?? DEFAULT_PORT;
const host = env["HOST"] ?? "127.0.0.1";
const originOf = (value: number): string => `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${value}`;
let origin = originOf(port);

/**
 * herdr's PATH plus where the one-line installer (install.sh) puts Bun, Node and herdr: herdr may
 * have been started from a shell that has none of them, and the server spawns `node` for every
 * terminal. Appended, so a Node the user chose (nvm, Homebrew) still comes first.
 */
function toolPath(): string {
  const current = (env[PATH_KEY] ?? "").split(delimiter).filter(Boolean);
  const home = homedir();
  const extra = [join(home, ".bun", "bin"), join(home, ".local", "bin"), join(home, ".local", "share", "herdr-web-ui", "node", "bin")];
  return [...current, ...extra.filter((dir) => existsSync(dir) && !current.includes(dir))].join(delimiter);
}

/** A clickable address where a terminal shows it (OSC 8), plain where the output goes to a log or a file. */
function link(url: string): string {
  return process.stdout.isTTY ? `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\` : url;
}

function qr(text: string): string {
  const code = qrcode(0, "M");
  code.addData(text);
  code.make();
  return code.createASCII(1, 1);
}

async function health(): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    // the port may hold another program's 200 (a kept port that went stale): only the app's answer
    // counts, in the shape every release has sent (server/index.ts)
    const body = await response.json() as { ok?: unknown; herdr?: unknown; auth?: unknown };
    return body.ok === true && typeof body.herdr === "object" && body.herdr !== null && appAuth(body.auth);
  } catch {
    return false;
  }
}

/** Whether the app holds the port: its bridge health answers without asking herdr. */
async function appOnPort(): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/api/health?scope=bridge`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    // another program's JSON can say ok too: only the app's own answer (server/index.ts) counts
    const body = (await response.json()) as { ok?: unknown; auth?: unknown; bridge_protocol?: unknown };
    return body.ok === true && Number.isInteger(body.bridge_protocol) && appAuth(body.auth);
  } catch {
    return false;
  }
}

/** The `auth` the app's health answers carry: whether a token is required and whether this request got in. */
function appAuth(auth: unknown): boolean {
  const fields = auth as { required?: unknown; authenticated?: unknown } | null | undefined;
  return typeof fields?.required === "boolean" && typeof fields.authenticated === "boolean";
}

/** Why the app's full health fails, as it says: herdr's error while herdr is away; null when it answers now (herdr came back). */
async function healthError(): Promise<string | null> {
  try {
    // short, as health() is: the wait before this has already spent the start's deadline
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1500) });
    const body = (await response.json()) as { ok?: unknown; error?: { message?: unknown } };
    if (response.ok && body.ok === true) return null;
    return typeof body.error?.message === "string" ? body.error.message : `its health check answered ${response.status}`;
  } catch {
    return "its health check did not answer";
  }
}

function recordedPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const pid = Number(readFileSync(PID_FILE, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** names the keys only, never their values: a token must not reach herdr's log */
function warnShadowed(): void {
  if (shadowed.length === 0) return;
  process.stdout.write(`both env and .env in ${CONFIG_DIR} set ${shadowed.join(", ")}; .env wins. Merge them into one file.\n`);
}

/**
 * A start's failure, in full to herdr's plugin log and in one line to server.log: the Windows
 * launcher runs this in a hidden console, so the log is all it can show.
 */
function failStart(message: string, detail = ""): number {
  process.stderr.write(`${message}${detail}\n`);
  appendFileSync(LOG_FILE, `start: ${message}\n`);
  return 1;
}

/** What the server wrote since `offset`: its own error is in the last lines. */
function logSince(offset: number): string {
  const lines = readFileSync(LOG_FILE).subarray(offset).toString("utf8").split("\n").filter((line) => line.trim() !== "");
  return lines.length === 0 ? "(nothing)" : lines.slice(-15).join("\n");
}

/**
 * Leaves `port` on one the server can open, or says why none is. Returns "running" when the port
 * was held by a server of ours that came up meanwhile.
 */
async function settlePort(): Promise<"ready" | "running" | "failed"> {
  if (await canBind(host, port)) return "ready";
  // a start still coming up holds the port: wait for it rather than open a second server beside it
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (recordedPid() !== null && Date.now() < deadline) {
    // that start may have moved to another port itself: follow its choice, or two servers end up side by side
    const kept = portSet ? port : savedPort(PORT_FILE) ?? DEFAULT_PORT;
    if (kept !== port) {
      port = kept;
      origin = originOf(port);
    }
    if (await health()) return "running";
    await Bun.sleep(250);
  }
  // the app holds the port but cannot reach herdr: another port would put a second server beside it (#428)
  if (await appOnPort()) {
    if (await health()) return "running";
    const why = await healthError();
    if (why === null) return "running";
    const pid = recordedPid();
    failStart(`herdr web ui is running at ${origin}${pid === null ? "" : ` (pid ${pid})`} but cannot reach herdr: ${why}. It keeps this port and answers again once herdr is back.`);
    return "failed";
  }
  const settings = CONFIG_FILES.at(-1) ?? join(CONFIG_DIR, "env");
  const blocked = platform() === "win32"
    ? `port ${port} on ${host} cannot be opened: another program has it, or Windows reserves it for Hyper-V, WSL2 or Docker (netsh interface ipv4 show excludedportrange protocol=tcp lists the reserved ranges).`
    : `port ${port} on ${host} cannot be opened: another program has it.`;
  if (portSet) {
    failStart(`${blocked} Set another PORT in ${settings}`);
    return "failed";
  }
  const free = await freePort(port, DEFAULT_PORT, (candidate) => canBind(host, candidate));
  if (free === null) {
    failStart(`${blocked} Neither can ${[DEFAULT_PORT, ...FALLBACK_PORTS].filter((candidate) => candidate !== port).join(", ")}. Put PORT=<a free port> in ${settings}`);
    return "failed";
  }
  process.stdout.write(`${blocked} Using port ${free} instead; to choose one yourself, put PORT=<port> in ${settings}\n`);
  port = free;
  origin = originOf(port);
  return "ready";
}

async function start(): Promise<number> {
  warnShadowed();
  if (await health()) {
    process.stdout.write(`herdr web ui already running at ${origin}\n`);
    return 0;
  }
  mkdirSync(STATE_DIR, { recursive: true });
  const settled = await settlePort();
  if (settled === "failed") return 1;
  if (settled === "running") {
    process.stdout.write(`herdr web ui already running at ${origin}\n`);
    return 0;
  }
  if (!portSet) {
    // kept, so the address a phone or a bookmark holds survives a restart
    if (port === DEFAULT_PORT) rmSync(PORT_FILE, { force: true });
    else {
      mkdirSync(APP_STATE_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(`${PORT_FILE}.tmp`, `${port}\n`, { mode: 0o600 });
      renameSync(`${PORT_FILE}.tmp`, PORT_FILE);
    }
  }
  const log = openSync(LOG_FILE, "a");
  const logged = statSync(LOG_FILE).size;
  const child = spawn(process.execPath, [join(ROOT, "server", "managed.ts")], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", log, log],
    env: {
      ...env,
      [PATH_KEY]: toolPath(),
      HOST: host,
      PORT: String(port),
      // herdr hands the plugin HERDR_SOCKET_PATH; the server (and the attach it
      // spawns) reads HERDR_SOCKET
      ...(env["HERDR_SOCKET_PATH"] !== undefined ? { HERDR_SOCKET: env["HERDR_SOCKET_PATH"] } : {}),
    },
  });
  child.unref();
  if (child.pid === undefined) {
    process.stderr.write("could not spawn the server\n");
    return 1;
  }
  writeFileSync(PID_FILE, `${child.pid}\n`, { mode: 0o600 });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  // a server that has exited will not answer: its last words are in the log now
  while (Date.now() < deadline && child.exitCode === null) {
    if (await health()) {
      process.stdout.write(`herdr web ui listening at ${origin}\n`);
      if ((env["HERDR_WEB_TOKEN"] ?? "") === "") {
        process.stdout.write(`no token set: your own Tailscale devices get in as you; pair any other device in Settings → Devices, or put HERDR_WEB_TOKEN=<token> in ${join(CONFIG_DIR, "env")}\n`);
      }
      return 0;
    }
    await Bun.sleep(250);
  }
  const why = child.exitCode === null
    ? `server did not answer ${origin}/api/health within ${READY_TIMEOUT_MS / 1000}s`
    : `the server stopped (exit ${child.exitCode}) before it answered ${origin}/api/health`;
  return failStart(why, `; ${LOG_FILE} ends with:\n${logSince(logged)}`);
}

/**
 * Whether a process (a pid) or process group (a negative pgid) has a member that has not exited,
 * from /proc: a zombie, exited but not yet reaped by its parent, still answers `kill(pid, 0)`.
 * null without /proc (macOS), where signal 0 is all there is.
 */
function liveProcess(target: number): boolean | null {
  if (!existsSync("/proc/self/stat")) return null;
  // "<pid> (<comm>) <state> <ppid> <pgrp> ...": comm may hold spaces and parens
  const stat = (pid: string): { state: string; group: number } | null => {
    try {
      const fields = readFileSync(`/proc/${pid}/stat`, "utf8");
      const [state, , group] = fields.slice(fields.lastIndexOf(")") + 2).split(" ");
      return { state: state!, group: Number(group) };
    } catch {
      return null; // gone meanwhile
    }
  };
  if (target > 0) {
    const own = stat(String(target));
    return own !== null && own.state !== "Z";
  }
  return readdirSync("/proc").some((pid) => {
    if (!/^\d+$/.test(pid)) return false;
    const member = stat(pid);
    return member !== null && member.group === -target && member.state !== "Z";
  });
}

/**
 * Returns once the server is gone. It stops answering at once, but its supervisor holds the
 * checkout's lock until the bridge under it exits, and a `start` before then finds that lock,
 * gives up, and leaves nothing running.
 */
async function stop(): Promise<number> {
  const pid = recordedPid();
  if (pid === null) {
    rmSync(PID_FILE, { force: true });
    process.stdout.write("herdr web ui is not running\n");
    return 0;
  }
  // the whole process group when the server leads one, as `start` spawns it
  let target = platform() === "win32" ? pid : -pid;
  if (platform() === "win32") {
    // A stale PID can belong to another app, or a newer instance of this plugin.
    const recordedAt = statSync(PID_FILE).mtimeMs;
    const owner = (await windowsProcessTable()).find(row => row.pid === pid);
    const argv = windowsArgv(owner?.commandLine ?? "");
    if (owner?.path?.toLowerCase() !== process.execPath.toLowerCase()
      || argv[1]?.toLowerCase() !== join(ROOT, "server", "managed.ts").toLowerCase()
      || owner.started === undefined || owner.started > recordedAt
      || !existsSync(PID_FILE) || statSync(PID_FILE).mtimeMs !== recordedAt
      || Number(readFileSync(PID_FILE, "utf8").trim()) !== pid) {
      process.stderr.write("could not verify the recorded herdr web ui process; it was left running and its pid file was kept\n");
      return 1;
    }
    // Windows has no Unix process groups or graceful SIGTERM: include the supervisor and bridge.
    const killed = spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, encoding: "utf8" });
    if (killed.status !== 0 && recordedPid() !== null) {
      process.stderr.write(`could not stop herdr web ui: ${killed.error?.message ?? killed.stderr.trim()}\n`);
      return 1;
    }
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    let exited = false;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") { exited = true; break; } }
      const current = (await windowsProcessTable(Math.max(1, deadline - Date.now()))).find(row => row.pid === pid);
      if (current?.started !== undefined && current.started !== owner.started) { exited = true; break; }
      await Bun.sleep(100);
    }
    if (!exited) {
      process.stderr.write("could not confirm herdr web ui stopped; its pid file was kept\n");
      return 1;
    }
    // Never send another kill to a number Windows may have reassigned after taskkill.
    if (existsSync(PID_FILE) && statSync(PID_FILE).mtimeMs === recordedAt
      && Number(readFileSync(PID_FILE, "utf8").trim()) === pid) rmSync(PID_FILE);
    process.stdout.write(`stopped herdr web ui (pid ${pid})\n`);
    return 0;
  } else {
    try {
      process.kill(target, "SIGTERM");
    } catch {
      target = pid;
      process.kill(pid, "SIGTERM");
    }
  }
  const running = (): boolean => {
    try {
      process.kill(target, 0);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
    // an exited server its parent has not reaped yet still answers signal 0
    return liveProcess(target) ?? true;
  };
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (running() && Date.now() < deadline) await Bun.sleep(100);
  const killed = running();
  if (killed) {
    try { process.kill(target, "SIGKILL"); } catch { /* gone meanwhile */ }
    // SIGKILL only asks: the lock is free, and a start can follow, once the group is gone
    const killDeadline = Date.now() + KILL_WAIT_MS;
    while (running() && Date.now() < killDeadline) await Bun.sleep(100);
    if (running()) {
      process.stderr.write(`herdr web ui (pid ${pid}) is still running after SIGKILL; its pid file is kept\n`);
      return 1;
    }
  }
  // a start that ran meanwhile may have recorded its own server: leave that one's pid file alone
  if (existsSync(PID_FILE) && Number(readFileSync(PID_FILE, "utf8").trim()) === pid) rmSync(PID_FILE, { force: true });
  process.stdout.write(`stopped herdr web ui (pid ${pid})${killed ? `; it was still running after ${STOP_TIMEOUT_MS / 1000}s, so it was killed` : ""}\n`);
  return 0;
}

/**
 * A pairing code for another device, printed here. A headless PC has no browser of its own to
 * open Settings → Devices in, so this is how its owner lets a phone in: the code, the address the
 * phone opens (when Tailscale serves one), and that address as a QR code for a screen to scan.
 */
async function pair(): Promise<number> {
  if (!(await health())) {
    process.stderr.write(`herdr web ui is not running at ${origin}; start it first\n`);
    return 1;
  }
  const headers: Record<string, string> = { "content-type": "application/json", "x-herdr-machine": "1" };
  if ((env["HERDR_WEB_TOKEN"] ?? "") !== "") headers["authorization"] = `Bearer ${env["HERDR_WEB_TOKEN"]}`;
  const started = await fetch(`${origin}/api/devices/pair/start`, { method: "POST", headers, body: "{}" });
  if (!started.ok) {
    process.stderr.write(`could not start a pairing (${started.status}): ${await started.text()}\n`);
    return 1;
  }
  const { code } = (await started.json()) as { code: string; expires_at: string };
  let url: string | null = null;
  try {
    const access = (await (await fetch(`${origin}/api/access`, { headers })).json()) as { tailscale: { serving_url: string | null } };
    url = access.tailscale.serving_url;
  } catch { /* an older server: the code alone */ }
  const out: string[] = [`Pairing code: ${code.slice(0, 3)} ${code.slice(3)}   (good for 10 minutes, for one device)`];
  if (url !== null) {
    out.push(`On the other device, open ${link(url)} and enter the code, or scan this to open it with the code filled in:`, "");
    out.push(qr(`${url}/?pair=${code}`));
  } else {
    out.push("On the other device, open the app's address and enter the code. Settings → Phone, on any signed-in device, shows the address and how to get one.");
  }
  process.stdout.write(out.join("\n") + "\n");
  return 0;
}

/**
 * The address a phone opens, as a QR code. When Tailscale runs on this PC but does not yet serve
 * the app, this is the one place that changes it: `tailscale serve` of the app's port on the first
 * free HTTPS port, said out loud with the command that undoes it. Everything else only reads.
 * Run by install.sh (and by hand); neither the server nor startup ever calls it.
 */
async function phone(): Promise<number> {
  const say = (line = "") => process.stdout.write(line + "\n");
  const running = await health();
  say(`herdr web ui on this PC: ${link(origin)}${running ? "" : " (not running yet: it starts with herdr)"}`);
  if (!["127.0.0.1", "0.0.0.0", "localhost"].includes(host)) {
    say(`HOST is ${host}, so Tailscale, which serves 127.0.0.1, is left alone. On the phone, open ${link(`http://${host}:${port}`)}.`);
    return 0;
  }
  const binary = tailscaleBinary();
  let output = await readTailscale(binary);
  let access = parseTailscale(output, port);
  if (binary === null || access.state === "missing") {
    say("For your phone: install Tailscale on this PC and on the phone (https://tailscale.com/download),");
    say(`sign in to the same account on both, then run: ${PHONE_AGAIN}`);
    return 0;
  }
  if (access.state === "stopped") {
    say(`For your phone: Tailscale is installed but not signed in. Run \`tailscale up\` (or open the Tailscale app), then run: ${PHONE_AGAIN}`);
    return 0;
  }
  let published = false;
  if (access.serving_url === null) {
    if (access.serve_command === null) {
      say("Tailscale on this PC already uses every HTTPS port this would take (443, 8443, 7317, 17317). Settings → Phone shows what to do.");
      return 0;
    }
    say(`Publishing the app to your tailnet: ${access.serve_command}`);
    const [, ...args] = access.serve_command.split(" ");
    const serve = Bun.spawn([binary, ...args.slice(0, 1), "--yes", ...args.slice(1)], { windowsHide: true, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    const timer = setTimeout(() => serve.kill(), SERVE_TIMEOUT_MS);
    const code = await serve.exited;
    clearTimeout(timer);
    if (code !== 0) {
      say(`Tailscale did not take it (exit ${code}).${platform() === "linux" ? " On Linux, let your user change Tailscale once with `sudo tailscale set --operator=$USER`," : ""}`);
      say(`then run: ${PHONE_AGAIN}   Or run the command above yourself.`);
      return 1;
    }
    output = await readTailscale(binary);
    access = parseTailscale(output, port);
    published = true;
  }
  const url = access.serving_url;
  if (url === null) {
    say("Tailscale accepted the command, but does not report the address yet. Settings → Phone shows it once it does.");
    return 1;
  }
  const httpsPort = new URL(url).port || "443";
  if (published) say(`Tailscale now serves ${url} → http://127.0.0.1:${port}, for your tailnet only. To undo: tailscale serve --https=${httpsPort} off`);
  const owner = parseTailscaleOwner(output?.status ?? null);
  const ip = parseTailscaleIp(output?.status ?? null);
  say("");
  say(`On your phone: ${link(url)}`);
  // the name, not the IP, is what the HTTPS certificate is for: https://100.x.y.z would warn
  if (ip !== null) say(`Tailscale IP of this PC: ${ip}. Open the name above, not the IP: the HTTPS certificate is for the name.`);
  say(`Scan this with a phone signed in to Tailscale${owner === null ? "" : ` as ${owner}`}; that login gets in without a code (with HERDR_WEB_TOKEN set, after entering the token once).`);
  say("Anyone else on your tailnet needs a pairing code: Settings → Devices, or the pair command.");
  say(qr(url));
  return 0;
}

/** The marketplace action has a real pane, so its address, QR and pairing code stay visible. */
async function phoneSetup(): Promise<number> {
  const active = activePluginScript(ROOT, port, APP_STATE_DIR);
  if (active !== join(resolve(ROOT), "scripts", "plugin.ts") && resolve(active) !== resolve(import.meta.filename)) {
    const child = Bun.spawn([process.execPath, active, "phone-setup"], { cwd: ROOT, windowsHide: true, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return await child.exited;
  }
  process.stdout.write(`Phone setup\n\nApp on this PC: ${link(origin)}\n`);
  let code = 0;
  if (!(await health())) {
    process.stdout.write("The app is not running. Run the Start herdr web ui action, then reopen Phone setup.\n");
    code = 1;
  } else {
    const headers: Record<string, string> = {};
    if (env["HERDR_WEB_TOKEN"]) headers["authorization"] = `Bearer ${env["HERDR_WEB_TOKEN"]}`;
    try {
      const response = await fetch(`${origin}/api/access`, { headers, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`access request failed (${response.status})`);
      const access = await response.json() as RemoteAccess;
      if (!access.tailscale.serving_url) {
        if (access.tailscale.serve_command) process.stdout.write(`To make a phone address, run this on the PC, then reopen Phone setup:\n\n  ${access.tailscale.serve_command}\n\n`);
        else process.stdout.write("For a phone address, set up Tailscale on both devices, or use your own HTTPS proxy. Settings → Phone shows the connection options.\n\n");
      }
      code = await pair();
    } catch {
      process.stderr.write("Could not read phone setup. Check the app's token and connection, then reopen this pane.\n");
      code = 1;
    }
  }
  if (process.stdin.isTTY) {
    process.stdout.write("\nPress Enter to finish. Reopen Phone setup for a fresh pairing code.\n");
    await new Promise<void>((done) => { process.stdin.once("data", () => done()); process.stdin.resume(); });
    process.stdin.pause();
  }
  return code;
}

/** Reporting "down" is not an action failure: herdr logs a nonzero exit as failed. */
async function status(): Promise<number> {
  const pid = recordedPid();
  const up = await health();
  process.stdout.write(`${up ? "running" : "down"} ${origin}${pid === null ? "" : ` (pid ${pid})`}\n`);
  process.stdout.write(`config: ${CONFIG_FILES.length === 0 ? `none (settings go in ${join(CONFIG_DIR, "env")})` : CONFIG_FILES.join(", ")}\n`);
  warnShadowed();
  return 0;
}

const command = process.argv[2] ?? "status";
if (command === "start") process.exit(await start());
else if (command === "stop") process.exit(await stop());
else if (command === "status") process.exit(await status());
else if (command === "pair") process.exit(await pair());
else if (command === "phone") process.exit(await phone());
else if (command === "phone-setup") process.exit(await phoneSetup());
else {
  process.stderr.write(`usage: bun scripts/plugin.ts <start|stop|status|pair|phone|phone-setup>\n`);
  process.exit(2);
}
