import "./adopt-legacy-env.ts";
import { handleWorkspaceRequest } from "./workspace-routes.ts";
import { connectionData, createCore, type SocketData } from "./core/index.ts";
import { ClientConnectionLog } from "./client-connection-log.ts";
import { RequestLog } from "./request-log.ts";
import { handlePaneRequest } from "./pane-routes.ts";
import { paneContext, resolveAgent } from "./pane-context.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { OrderSequence } from "./order-sequence.ts";
import { readHerdrProfiles, type HerdrMachineProfile } from "./herdr-profiles.ts";
import { accessSync, constants, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AgentKind, HealthAuth, HerdrPane, IntegrationsResponse, PanePlan, PendingMessage, PluginActionsResponse, ProjectFavicon } from "../shared/protocol.ts";
import { DEFAULT_PORT } from "../shared/protocol.ts";
import { authClient, deviceCookieValue, bearerMatches, handleAuthRequest, isAuthenticated, isSecureRequest, parseCookies, presentedToken, presentedTokenHeld, recordPresentedTokenFailure, requiresAuth, unauthorizedJson } from "./auth.ts";
import { cameThroughProxy, decideAccess, isLoopbackAddress, isLoopbackBind, isServeOwnerRequest, lanExposed } from "./access.ts";
import { DeviceStore, handleDeviceRequest, type DeviceMatch } from "./devices.ts";
import { handlePreferencesRequest, PreferenceStore } from "./preferences.ts";
import { handleSeenRequest, SeenStore } from "./seen.ts";
import { remoteAccess, TailnetIdentitySource } from "./tailscale.ts";
import { badRequest, errorResponse, jsonResponse, readJsonObject, setRequestRoute } from "./http.ts";
import { requestOrigin, serveStatic } from "./static.ts";
import { compressResponse } from "./compress.ts";
import { claudePaneSession } from "./conversation.ts";
import { processAlive } from "./omo-status.ts";
import { omoRuns, omoTasks } from "./omo-tasks.ts";
import { claudeSubagents, within } from "./claude-subagents.ts";
import { SHELL_AGENTS, shellAgentExecutable } from "./shell-agent.ts";
import { claudeSessionTempDir } from "./claude-store.ts";
import { fileResponse, findFile, crossSiteFileRead, forgetPageMedia, pageMediaResponse, pageMediaSource, PAGE_MEDIA_PATH } from "./file-view.ts";
import { findProjectFavicon } from "./project-favicon.ts";
import {
  agentManifests,
  HerdrError,
  herdrSocketPath,
  integrationList,
  paneGet,
  ping,
  pluginActionInvoke,
  pluginActionList,
  pluginList,
  pluginLogList,
  type PluginInvocationContext,
  sessionSnapshot,
} from "./herdr/client.ts";
import { type AlertTiming, defaultStateDir, handlePushRequest } from "./push.ts";
import { moveLegacyStateDir } from "./update-state.ts";
import { handlePromptRequest, OpenCodePromptState } from "./prompt.ts";
import { attachableIdentity } from "./pty/sidecar.ts";
import { connectUpdater, handleUpdateRequest, type UpdateService } from "./update-api.ts";
import { handleHerdrUpdateRequest, HerdrUpdater } from "./herdr-update.ts";
import { handlePortalRequest, PortalService } from "./portal.ts";
import { handleTelemetryRequest, Telemetry } from "./telemetry.ts";
import { handleUsageRequest, UsageService } from "./usage.ts";
import { CLIProxyService } from "./cliproxy.ts";
import { CLIProxyRoutes } from "./cliproxy-routes.ts";
import { UsageLoginService } from "./usage-login.ts";
import { handleVoiceRequest, VoiceService } from "./voice.ts";

import { BRIDGE_PROTOCOL } from "../shared/machines.ts";
import { bridgeIdentity, registerBridge } from "./bridge.ts";
import { handleMachineRequest, nonCanonicalPath } from "./machine-api.ts";
import { handleSessionHistoryRequest, SESSION_HISTORY_PATH } from "./session-history-routes.ts";
import { HerdrSidebarConfig, herdrConfigPath } from "./herdr-sidebar.ts";
import { closeCodexDaemonSources } from "./codex-daemon.ts";
import { MachineRelay } from "./machine-relay.ts";
import { sameOrigin } from "./machine-security.ts";
import { PLUGIN_LOG_LIMIT, pluginActionResult, pluginLogEntry, pluginPaneContext, waitForPluginAction } from "./plugin-actions.ts";

/** How herdr's plugin manifests name the platform this server (and so its herdr) runs on. */
const PLUGIN_PLATFORM = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
/** How long POST /api/plugin/action waits for the command herdr started to end before it answers `running`. */
const PLUGIN_ACTION_WAIT_MS = 5_000;
const livePaneIds = async (timeoutMs?: number): Promise<string[]> => (await sessionSnapshot(undefined, timeoutMs)).panes.map((pane) => pane.pane_id);
/** The gap between a composer message's text and its Enter (see submitText). */
export const SUBMIT_DELAY_MS = 120;
/**
 * herdr holds a lone ESC typed through the attach pty ~150ms (measured) to tell it from
 * an Alt+key: a composer message waits this long after the pane's last keystroke, so a
 * Stop tapped just before Send still reaches the pane first.
 */
const TYPED_SETTLE_MS = 300;
/**
 * A terminal key (WS `keys`) goes through herdr's RPC, around the attach pty: it waits this long
 * after the pane's last pty keystroke so it never overtakes typing on its way through the
 * sidecar and the attach, and the whole TYPED_SETTLE_MS when that keystroke ended in an ESC
 * herdr may still be holding. Short enough that a held arrow between typed letters shows no lag.
 */
const KEY_SETTLE_MS = 40;
/**
 * Nothing of a composer message is typed once this long has passed since it reached the
 * server (it can wait behind a stalled one in the pane's queue): it answers submit_timeout
 * instead. A send that starts in time ends within two more 10s RPCs, before the client
 * stops waiting (SUBMIT_TIMEOUT_MS in src/lib/ws.ts), so a message it gave up on never
 * reaches the pane later.
 */
export const SUBMIT_DEADLINE_MS = 45_000;
/** How long a cleared Claude input box may take to read empty before the send is refused after all. */
const DRAFT_CLEAR_WAIT_MS = 1_500;
const DRAFT_CLEAR_POLL_MS = 50;


const AGENT_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  omp: "Oh My Pi",
  omo: "OmO",
  gjc: "Gajae Code",
  pi: "pi",
  gemini: "Gemini CLI",
  cursor: "Cursor",
  opencode: "OpenCode",
  copilot: "GitHub Copilot",
  kimi: "Kimi",
  amp: "Amp",
  hermes: "Hermes",
  grok: "Grok",
  agy: "Antigravity",
  devin: "Devin",
  cmd: "Command Code",
};

/** The temp folder of the Claude Code session in a pane, or null when the pane runs none or it has none. */
async function claudeTempFolder(paneId: string): Promise<string | null> {
  try {
    const pane = await paneGet(paneId);
    if (resolveAgent(pane).agent !== "claude") return null;
    const session = await claudePaneSession(pane);
    return session === null ? null : await claudeSessionTempDir(session.path);
  } catch { return null; /* herdr busy or the pane gone: the path stays not found */ }
}

/**
 * What Bun.serve admits before a route runs (64 MiB). The ~55.9 MB body of a 40 MiB file is under it,
 * so the attachment route answers it with its JSON reason. The browser refuses a file over
 * MAX_ATTACHMENT_BYTES before it uploads (src/lib/api.ts), so only a non-browser client that sends
 * more than this can still see Bun's own empty 413.
 */
const BUN_BODY_CEILING = 64 * 1024 * 1024;

export interface ServerInstance {
  port: number;
  hostname: string;
  statusReady: Promise<void>;
  alertsSettled: () => Promise<void>;
  /**
   * queues a create request's first message for a pane's agent, as POST /api/workspace/create and /api/tab/create do with
   * `first_message` and `first_message_connection` (`requester`, a connection's id from its first snapshot): for tests that start no agent
   */
  queueFirstMessage: (paneId: string, text: string, kind: string, requester?: string | null, launchedPid?: number | null) => Promise<PendingMessage>;
  stop: () => void;
}

export function createServer(
  options: {
    port?: number;
    hostname?: string;
    token?: string;
    /** where VAPID keys and push subscriptions persist; tests pass a temp dir */
    stateDir?: string;
    /** the PC's own Tailscale login, for the identity check; tests set it, otherwise `tailscale status` says */
    tailscaleOwner?: string | null;
    /** the operator declares `tailscale serve` as this install's only ingress; OVIS_TAILSCALE_SERVE_ONLY=1 says the same */
    tailscaleServeOnly?: boolean;
    /** the tailnet identity behind the access check; unset, the tailscale CLI says. Tests pass one with their own status reader. */
    tailnet?: TailnetIdentitySource;
    /** Native Codex store; defaults to CODEX_HOME. Tests use an isolated store. */
    codexHome?: string;
    grokHome?: string;
    /** OpenCode's database; defaults to where OpenCode finds it (OPENCODE_DB, XDG_DATA_HOME). Tests use an isolated store. */
    opencodeDb?: string;
    /** OpenCode state dir where service.json lives; tests use an isolated directory. */
    openCodeStateDir?: string;
    /** Native Devin store; tests pass an isolated SQLite database. */
    devinDbPath?: string;
    /** Native Hermes store; pane process HERMES_HOME wins when this is unset. Tests use an isolated store. */
    hermesHome?: string;
    updates?: UpdateService;
    /** updates herdr itself (server/herdr-update.ts); unset, the app offers no herdr update. Tests pass one that runs a stand-in herdr. */
    herdrUpdate?: HerdrUpdater;
    /** a public address through Portal (server/portal.ts); unset, the app offers none. Tests pass one that runs a stand-in portal. */
    portal?: PortalService;
    /** anonymous install and update counts (server/telemetry.ts); unset, the server sends none and answers 404. Only the real entrypoint passes one. */
    telemetry?: Telemetry;
    /** plan limits of the AI subscriptions signed in here; tests pass one without real sign-ins */
    usage?: UsageService;
    /** Tests supply an isolated proxy service, never a user's configured instance. */
    cliProxy?: CLIProxyService;
    /** Tests use a disposable credential home and stand-in CLI binaries. */
    usageLogin?: UsageLoginService;
    /** voice input's key, provider and models; tests pass one with their own env and fetch */
    voice?: VoiceService;
    machines?: boolean;
    /** Read-only saved profiles from the local herdr client; tests supply their own catalog. */
    herdrProfiles?: () => Promise<HerdrMachineProfile[]>;
    /** herdr's config.toml, for its sidebar rows (server/herdr-sidebar.ts); unset, where herdr itself reads it. Tests pass a temp file. */
    herdrConfigPath?: string;
    registerBridge?: boolean;
    /** PLUGIN_ACTION_WAIT_MS; a test shortens it to see a run that outlasts the wait */
    pluginActionWaitMs?: number;
    /** SUBMIT_DEADLINE_MS; tests shorten it */
    submitDeadlineMs?: number;
    /** SUBMIT_DELAY_MS; a test lengthens it to hold a second message behind the first */
    submitDelayMs?: number;
    /** How long a queued send waits for a confirmed new turn to start; tests shorten it. */
    pendingStartTimeoutMs?: number;
    /** how long a push alert waits for the pane to change first (server/push.ts); tests send at once */
    alertTiming?: Partial<AlertTiming>;
    /** accept plain-http loopback push endpoints (server/push.ts); only tests delivering to push.fake.ts set it */
    pushLoopbackHttp?: boolean;
    /** how long a turn's end is held for its background work (server/background-wait.ts); tests shorten it */
    backgroundWait?: { grace: number; limit: number };
    /** Clock for background holds and alert turn durations; tests advance it explicitly. */
    statusNow?: () => number;
    /** ATTACH_RETRY_FOR_MS; tests shorten it */
    attachRetryForMs?: number;
    /** ATTACH_HELD_RETRY_MS; tests shorten it */
    attachHeldRetryMs?: number;
    /** ATTACH_RELOOKUP_FOR_MS; tests shorten it */
    attachRelookupForMs?: number;
    /** ATTACH_HOLD_MS; a test lengthens it so an attach's exit always comes before its hold ends */
    attachHoldMs?: number;
    /** whether herdr can `terminal attach`; unset, its ping says, and this runtime's PTY sidecar has to be runnable. Tests give a Windows herdr's answer, at once or as late as a ping's. */
    terminalAttach?: boolean | (() => Promise<boolean>);
    /** whether this runtime can run the PTY sidecar; unset, server/pty/sidecar.ts says. Tests give a runtime without Node or node-pty, while herdr keeps its own answer, or a probe to run in place of that one. */
    sidecar?: boolean | (() => boolean);
  } = {},
): ServerInstance {
  /**
   * This server's lifetime: the supervisor's boot id when it manages the server, else one made now. It is
   * /api/health's `web_ui.boot_id` and the epoch of the workspace order's counter (server/order-sequence.ts).
   */
  const bootId = process.env["OVIS_BOOT_ID"] || randomUUID();
  const orderSequence = new OrderSequence(bootId);
  const hostname = options.hostname ?? process.env["HOST"] ?? "127.0.0.1";
  /** Empty token = gate disabled; every route then behaves exactly as it did before auth existed. */
  const token = options.token ?? process.env["OVIS_TOKEN"] ?? "";
  /** paired devices (server/devices.ts) and the PC's Tailscale login: the two ways in besides the token and this PC itself */
  const devices = new DeviceStore(options.stateDir ?? defaultStateDir());
  const preferences = new PreferenceStore(options.stateDir ?? defaultStateDir());
  const seen = new SeenStore(options.stateDir ?? defaultStateDir());
  const herdrSidebar = new HerdrSidebarConfig(options.herdrConfigPath ?? herdrConfigPath());
  const cliProxy = options.cliProxy ?? new CLIProxyService(options.stateDir ?? defaultStateDir());
  const cliProxyRoutes = new CLIProxyRoutes(cliProxy);
  const usageLogin = options.usageLogin ?? new UsageLoginService();
  const usage = options.usage ?? new UsageService(undefined, undefined, (refresh) => cliProxy.report(refresh));
  const voice = options.voice ?? new VoiceService({ stateDir: options.stateDir ?? defaultStateDir(), env: process.env, fetch });
  /** a login named here is taken as it is: a tagged node has none of its own to read (OVIS_TAILSCALE_OWNER) */
  const namedOwner = options.tailscaleOwner !== undefined ? options.tailscaleOwner : process.env["OVIS_TAILSCALE_OWNER"]?.trim() || undefined;
  const tailnet = options.tailnet ?? new TailnetIdentitySource();
  const identityOf = async (grantPath: boolean, host: string | null) => {
    if (namedOwner !== undefined) return { ...(grantPath ? await tailnet.freshIdentity(host) : { soleLogin: null, dnsName: null, tailnetIp: null }), owner: namedOwner, tagged: false };
    return grantPath ? tailnet.freshIdentity(host) : tailnet.identity();
  };
  const serveOnly = options.tailscaleServeOnly ?? process.env["OVIS_TAILSCALE_SERVE_ONLY"] === "1";
  /** what lets Portal open an address: this server's own values, never a request's */
  const portalGuards = () => ({ tokenSet: token !== "", serveOnly });

  const openCodeState = new OpenCodePromptState();
  const draftTimer = setInterval(() => openCodeState.prune(), 60_000);
  draftTimer.unref();
  const core = createCore({ options: { ...options, openCodeState, orderSequence }, devices, usage, usageLogin, TYPED_SETTLE_MS, KEY_SETTLE_MS, SUBMIT_DEADLINE_MS, SUBMIT_DELAY_MS, DRAFT_CLEAR_WAIT_MS, DRAFT_CLEAR_POLL_MS });
  const { sidecar, serialize, push, logPushError, omo, claudeAgents, plans, clientSnapshot, machines, broadcastAll, collector, queueFirstMessage } = core;
  // started after createCore's Node probe (server/pty/sidecar.ts), which can hold the thread up to 3 s: that wait
  // would count against the read's own 2.5 s limit, and a read cut short leaves the owner unknown for 5 minutes
  identityOf(false, null);
  const bridgeToken = randomBytes(32).toString("hex");

  type PortalStartup = { ok: true } | { ok: false; error: unknown };
  let settlePortalStartup!: (result: PortalStartup) => void;
  let portalStartupResult: PortalStartup | undefined;
  const portalStartup = new Promise<PortalStartup>((resolve) => {
    settlePortalStartup = (result) => {
      if (portalStartupResult !== undefined) return;
      portalStartupResult = result;
      resolve(result);
    };
  });

  const envPort = process.env["PORT"];
  const clientConnectionLog = new ClientConnectionLog();
  const server = Bun.serve<SocketData>({
    port: options.port ?? (envPort ? Number(envPort) : DEFAULT_PORT),
    hostname,
    maxRequestBodySize: BUN_BODY_CEILING,

    async fetch(request, bunServer) {
      return requestLog.handle(request, async (headers) => {
      const startup = portalStartupResult ?? await portalStartup;
      if (!startup.ok) {
        setRequestRoute("startup");
        return compressResponse(request, errorResponse(startup.error));
      }
      // the route's answer, gzipped for a browser that takes it (server/compress.ts)
      return compressResponse(request, await (async (): Promise<Response | undefined> => {
      const url = new URL(request.url);
      let { pathname } = url;
      const bridgeAuthorized = isAuthenticated(request, bridgeToken);
      const bridgePath = pathname === "/api/bridge" || pathname === "/api/session" || pathname === SESSION_HISTORY_PATH || pathname === "/api/agents" || pathname === "/api/agent/rename" || pathname === "/api/agent/commands" || pathname === "/api/integrations" || pathname === "/api/plugins/actions" || pathname === "/api/plugin/action" || pathname.startsWith("/api/pane/") || pathname.startsWith("/api/workspace/") || pathname.startsWith("/api/worktree/") || pathname.startsWith("/api/tab/") || pathname === "/api/layout/ratio" || pathname.startsWith("/api/fs/") || pathname === "/ws";
      const ip = bunServer.requestIP(request);
      const loopback = ip !== null && isLoopbackAddress(ip.address);
      const forwarded = cameThroughProxy(request.headers);
      const funnel = request.headers.has("tailscale-funnel-request");
      const tailscaleLogin = request.headers.get("tailscale-user-login");
      const forwardedFor = request.headers.get("x-forwarded-for");
      const requestHost = request.headers.get("host");
      // the guessing budget of the address that asks (auth.ts): a token presented while it waits is not compared
      const client = authClient(ip?.address ?? null, request.headers);
      const presented = presentedToken(request, token, client);
      // counted at once, before any await below lets a concurrent guess pass the same check. Every
      // wrong token counts, a paired watch device's too (a right one would upgrade it to drive);
      // the connection server's own bridge token does not
      if (presented === "wrong" && !bridgeAuthorized) recordPresentedTokenFailure(client);
      const tokenMatched = presented === "match";
      let pairedDevice: DeviceMatch | null;
      try {
        pairedDevice = devices.match(deviceCookieValue(parseCookies(request.headers.get("cookie"))));
      } catch (error) {
        // First-cookie confirmation is an authorization write, not best-effort telemetry.
        return errorResponse(error);
      }
      const requestShape = { loopback, forwarded, funnel, tailscaleLogin, forwardedFor, serveOnly };
      const identity = await identityOf(token === "" && pairedDevice === null && isServeOwnerRequest(requestShape) && (pathname === "/ws" || pathname.startsWith("/api/")), requestHost);
      const access = decideAccess({
        ...requestShape,
        host: requestHost,
        tokenMatched,
        device: pairedDevice,
        ...identity,
        tokenConfigured: token !== "",
        gated: devices.gated,
      });
      const authenticated = access.level === "full" || (bridgePath && bridgeAuthorized);

      if (requiresAuth(pathname) && !authenticated) {
        setRequestRoute("auth-refusal");
        // a script's Bearer guess is told to wait; a browser's cookie gets the usual 401 and its sign-in form
        if (presented === "held" && pathname !== "/ws" && request.headers.has("authorization")) return presentedTokenHeld(client);
        // The WS client never parses a body, so the upgrade refusal stays plain text.
        return pathname === "/ws" ? new Response("unauthorized", { status: 401 }) : unauthorizedJson(access.level === "none" ? access.reason : "token_required");
      }

      const readOnly = access.level === "full" && access.role === "watch";
      const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
      if (pathname.startsWith("/api/") && mutating && !sameOrigin(request)) {
        setRequestRoute("origin-refusal");
        return jsonResponse({ error: { code: "invalid_origin", message: "Use controls from this app" } }, 403);
      }
      // An empty segment ("//", or a trailing "/") or an encoded separator reads as another route to
      // the checks below, while the PC proxy drops empty segments before forwarding:
      // `/api/machines/<id>//fs/file` would pass as not a file read, `<id>/sessions/history/` as no history.
      if (pathname.startsWith("/api/") && nonCanonicalPath(pathname)) return jsonResponse({ error: { code: "not_found", message: "not found" } }, 404);
      // What a watching device must not reach, spelled out rather than inferred from the
      // method: file contents (those files include credentials) and a directory listing
      // (names and sizes are the shape of a repository the terminals never print), plus
      // every mutation except the two below.
      const fileRead = /^\/api\/(?:machines\/[^/]+\/)?fs\//.test(pathname);
      const directoryListing = /^\/api\/(?:machines\/[^/]+\/)?workspace\/directories$/.test(pathname);
      // Signing a device's own alerts in is a preference of that device, so `watch` keeps
      // it. The endpoint it registers is https-only (server/push.ts), and that is the
      // protection: a watch device's subscription is delivered every status change anyway.
      // /api/push/test stays with a session that can drive only because it is a mutation.
      // A watch device may report its own connection metadata, never terminal input or file data.
      const ownPreferences = pathname === "/api/auth" || pathname === "/api/push/subscribe" || pathname === "/api/connection-diagnostics";
      // a repository's changes are file contents too: the patch of a credential file is that file
      const repositoryDiff = /^\/api\/(?:machines\/[^/]+\/)?workspace\/diff\//.test(pathname);
      // earlier sessions carry their first prompts
      const sessionHistory = /^\/api\/(?:machines\/[^/]+\/)?sessions\/history$/.test(pathname);
      // an agent's commands in a folder are read from that folder's command files, as a directory listing and a file read are
      const agentCommands = /^\/api\/(?:machines\/[^/]+\/)?agent\/commands$/.test(pathname);
      if (readOnly && (fileRead || directoryListing || repositoryDiff || sessionHistory || agentCommands || mutating && !ownPreferences)) {
        setRequestRoute("watch-refusal");
        return jsonResponse({ error: { code: "read_only", message: "this device can only watch" } }, 403);
      }

      // API reads can chain several bounded 10 s Herdr RPCs. Give the handler time to return
      // its JSON result or timeout instead of Bun closing the socket at its default 10 s idle
      // cutoff. Static files keep their default; streaming and long-operation routes override
      // this finite budget below, after access and origin checks have passed. Only a signed-in
      // request gets it: the routes open without sign-in (health, auth, pairing) keep the default,
      // so an unauthenticated client cannot hold idle sockets for a minute.
      if (pathname.startsWith("/api/") && authenticated) bunServer.timeout(request, 60);

      if (pathname === "/api/bridge") {
        setRequestRoute(pathname);
        if (token === "" && !bridgeAuthorized) return unauthorizedJson();
        try { return jsonResponse(await bridgeIdentity(sidecar)); } catch (error) { return errorResponse(error); }
      }
      if (pathname === "/api/machines" || pathname.startsWith("/api/machines/")) {
        if (!machines) return jsonResponse({ error: { code: "bridge_only", message: "Manage PCs on the connection server" } }, 404);
        // /local aliases preserve every existing endpoint without a self-proxy.
        if (pathname.startsWith("/api/machines/local/")) {
          if (!sameOrigin(request) || (request.method !== "GET" && request.headers.get("x-herdr-machine") !== "1")) return jsonResponse({ error: { code: "invalid_origin", message: "Use PC controls from this app" } }, 403);
          pathname = pathname.replace("/api/machines/local/", "/api/");
          if (!/^\/api\/(session|agents|integrations|pane\/|workspace\/|worktree\/|tab\/|layout\/ratio$|agent\/(?:rename|commands)$|plugins\/actions$|plugin\/action$|sessions\/history$)/.test(pathname)) return badRequest("invalid_route", "Unknown PC endpoint");
          url.pathname = pathname;
        } else {
          // a worktree made with an agent waits on git and then agent.start, up to 150 s on the PC
          bunServer.timeout(request, pathname === "/api/machines/events" ? 0 : pathname.endsWith("/worktree/create") ? 180 : 80);
          const deviceId = access.level === "full" ? access.device?.id : undefined;
          const response = await handleMachineRequest(request, machines, deviceId ? (close) => devices.onRevoke(deviceId, close) : undefined, preferences, readOnly, herdrSidebar, seen);
          response.headers.set("cache-control", "no-store");
          return response;
        }
      }
      if (pathname === "/ws") {
        setRequestRoute(pathname);
        if (!sameOrigin(request)) return new Response("invalid origin", { status: 403 });
        const deviceId = access.level === "full" ? access.device?.id : undefined;
        const machineId = url.searchParams.get("machine_id");
        if (machineId && machineId !== "local") {
          if (access.level === "none") return unauthorizedJson(access.reason);
          if (!machines?.endpoint(machineId)) return jsonResponse({ error: { code: "machine_offline", message: "This PC is disconnected" } }, 503);
          let relay: MachineRelay | undefined;
          try {
            relay = new MachineRelay(machines, machineId, readOnly);
            await relay.ready;
            const upgraded = bunServer.upgrade(request, { headers, data: connectionData({ relay, deviceId, readOnly }) });
            if (upgraded) return undefined;
            relay.close();
          } catch { relay?.close(); return new Response("remote websocket unavailable", { status: 502 }); }
          return new Response("websocket upgrade required", { status: 426 });
        }
        const upgraded = bunServer.upgrade(request, { headers, data: connectionData({ deviceId, readOnly }) });
        if (upgraded) return undefined;
        return new Response("websocket upgrade required", { status: 426 });
      }

      if (pathname === "/api/auth") {
        setRequestRoute(pathname);
        // signing out also ends the page media this browser was given (by its device, else by its address)
        // a browser can hold the token and a device cookie at once, and its renders are then the
        // client's: signing out ends both kinds
        if (request.method === "DELETE" && authenticated) {
          if (pairedDevice !== null) forgetPageMedia({ device: pairedDevice.id });
          forgetPageMedia({ client });
        }
        return handleAuthRequest(request, token, client);
      }
      if (pathname === "/api/devices" || pathname.startsWith("/api/devices/")) {
        try {
          const response = await handleDeviceRequest(request, pathname, devices, access);
          if (request.method === "DELETE" && response.status === 204) {
            // The device registry is the delivery authority even if cleaning the push file fails.
            try { push.revokeDevice(pathname.slice("/api/devices/".length)); } catch (error) { logPushError(error); }
            // and every page media address its renders were given
            forgetPageMedia({ device: pathname.slice("/api/devices/".length) });
          }
          return response;
        } catch (error) { return errorResponse(error); }
      }

      if (pathname === "/api/updates" || pathname.startsWith("/api/updates/")) {
        return handleUpdateRequest(request, pathname, options.updates);
      }
      if (pathname === "/api/herdr/update") { setRequestRoute(pathname); return handleHerdrUpdateRequest(request, options.herdrUpdate); }
      if (pathname === "/api/portal" || pathname.startsWith("/api/portal/")) {
        return handlePortalRequest(request, pathname, options.portal, { port: bunServer.port ?? DEFAULT_PORT, ...portalGuards() });
      }
      if (pathname === "/api/connection-diagnostics") { setRequestRoute(pathname); return clientConnectionLog.handle(request, client ?? "unknown"); }
      if (pathname === "/api/telemetry") { setRequestRoute(pathname); return handleTelemetryRequest(request, options.telemetry); }
      // what every browser of this server shares; a watching device reads it and cannot change it (above)
      if (pathname === "/api/preferences") { setRequestRoute(pathname); return handlePreferencesRequest(request, preferences); }
      // the finishes read in some browser of this server; a watching device reads them and cannot add to them (above)
      if (pathname === "/api/seen") { setRequestRoute(pathname); return handleSeenRequest(request, seen); }

      if (pathname === "/api/usage") { setRequestRoute(pathname); return handleUsageRequest(request, url, usage); }
      if (pathname === "/api/usage/login") { setRequestRoute(pathname); bunServer.timeout(request, 30); return usageLogin.handle(request, collector.trackPane); }
      if (pathname === "/api/cliproxy" || pathname.startsWith("/api/cliproxy/")) { bunServer.timeout(request, 60); return cliProxyRoutes.handle(request); }
      // a long clip can keep the provider silent past Bun's 10 s idle limit before the first line
      if (pathname === "/api/voice" || pathname.startsWith("/api/voice/")) { bunServer.timeout(request, 120); return handleVoiceRequest(request, pathname, voice); }

      if (pathname === "/api/push" || pathname.startsWith("/api/push/")) {
        try {
          // a paired device owns its alerts; the open LAN (before any pairing) owns them only while
          // it stays open, like a subscription from before owners (undefined); a local/token/
          // Tailscale sign-in is the owner (null)
          const owner = access.level !== "full" ? null : access.device?.id ?? (access.via === "open" ? undefined : null);
          const answered = await handlePushRequest(request, pathname, push, owner);
          if (answered) return answered;
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/health") {
        setRequestRoute(pathname);
        const auth: HealthAuth = access.level === "full"
          ? { required: false, authenticated: true, via: access.via, role: access.role, ...(access.via === "token" && bearerMatches(request, token) ? { bearer: true as const } : {}) }
          : { required: true, authenticated, ...(authenticated ? {} : { reason: access.reason }) };
        // this server is open to the network with no token and nothing paired, told to a client
        // that got in and to nobody else: naming it to an anonymous caller would be
        // reconnaissance, not help. Nothing here changes who is let in (server/access.ts).
        const lan_exposure = access.level === "full" && lanExposed({ hostname, tokenConfigured: token !== "", gated: devices.gated })
          ? { host: hostname } : undefined;
        if (url.searchParams.get("scope") === "bridge") return jsonResponse({ ok: true, auth, bridge_protocol: BRIDGE_PROTOCOL });
        try {
          const info = await ping();
          // a forced answer (tests) and a runtime without the PTY sidecar are told the way a Windows herdr's own would be
          const herdr = attachableIdentity(info, sidecar);
          return jsonResponse({ ok: true, herdr, auth, ...(lan_exposure ? { lan_exposure } : {}),
            web_ui: { boot_id: bootId, revision: process.env["OVIS_REVISION"] ?? null } });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/access") {
        setRequestRoute(pathname);
        if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
        return jsonResponse(await remoteAccess(bunServer.port ?? DEFAULT_PORT), 200, { "cache-control": "no-store" });
      }

      if (pathname === "/api/session") {
        setRequestRoute(pathname);
        try {
          return jsonResponse({ snapshot: await clientSnapshot() });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/agents") {
        setRequestRoute(pathname);
        if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
        try {
          const kinds = new Set((await agentManifests()).manifests.map((manifest) => manifest.agent));
          kinds.add("omp");
          kinds.add("claude");
          // not herdr kinds: offered where this server can run them (see shell-agent.ts)
          for (const kind of Object.keys(SHELL_AGENTS)) if (shellAgentExecutable(kind)) kinds.add(kind);
          const agents: AgentKind[] = [...kinds]
            // an agent's command is its kind; the pane's shell may carry another PATH, as for omo and gjc above
            .map((kind) => ({ kind, label: AGENT_LABELS[kind] ?? kind, installed: Bun.which(kind, { PATH: process.env["PATH"] ?? "" }) !== null }))
            .sort((left, right) => left.label.localeCompare(right.label) || left.kind.localeCompare(right.kind));
          return jsonResponse({ agents });
        } catch (error) {
          return errorResponse(error);
        }
      }

      // read only: installing one changes an agent's own hooks, which stays the user's call in a terminal
      if (pathname === "/api/integrations") {
        setRequestRoute(pathname);
        if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
        try {
          return jsonResponse({ integrations: await integrationList() } satisfies IntegrationsResponse);
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/fs/stat" || pathname === "/api/fs/file" || pathname === "/api/fs/favicon") {
        setRequestRoute(pathname);
        if (request.method !== "GET" && request.method !== "HEAD") return badRequest("method_not_allowed", "use GET");
        if (crossSiteFileRead(request)) return jsonResponse({ error: { code: "cross_site", message: "A file is read from this app or opened in a tab, not loaded by another page" } }, 403);
        // a folder's project icon: every place it may be kept, in one answer that a miss is part of
        if (pathname === "/api/fs/favicon") {
          const root = url.searchParams.get("root") ?? "";
          if (root.trim() === "") return badRequest("missing_root", "root is required");
          return jsonResponse({ icon: await findProjectFavicon(root) } satisfies ProjectFavicon);
        }
        const paneId = url.searchParams.get("pane_id");
        let cwd: string | null = null;
        if (paneId) {
          try { cwd = (await paneContext(paneId)).cwd; } catch { /* an absolute path still opens */ }
        }
        const path = url.searchParams.get("path") ?? "";
        const found = await findFile(path, cwd, () => paneId ? claudeTempFolder(paneId) : Promise.resolve(null));
        if (found === null) return jsonResponse({ error: { code: "not_found", message: "no readable file at that path" } }, 404);
        // several files end in that name: the viewer lists them to choose from
        if ("candidates" in found) return jsonResponse({ error: { code: "ambiguous_path", message: "several files have that name", candidates: found.candidates } }, 409);
        // a page another PC's server asks for through its bridge is played from that server's address, which this one cannot name: it is drawn as before
        const mediaSource = bridgeAuthorized ? null : pageMediaSource(requestHost, isSecureRequest(request), forwarded ? request.headers.get("x-forwarded-host") : null);
        // its media plays only for the client address that rendered it, and ends with that device (file-view.ts)
        const media = mediaSource === null ? null : { source: mediaSource, client, device: access.level === "full" ? access.device?.id ?? null : null };
        return pathname === "/api/fs/stat" ? jsonResponse(found.info) : fileResponse(found.info, url.searchParams.get("download") === "1", url.searchParams.get("render") === "1", media);
      }

      // a rendered page's own video, by the address its render gave it: the page has no origin and
      // no cookie, so the address is all it holds (requiresAuth lets this path through)
      if (pathname.startsWith(PAGE_MEDIA_PATH)) {
        setRequestRoute("/api/fs/page-media/:media_id");
        if (request.method !== "GET" && request.method !== "HEAD") return badRequest("method_not_allowed", "use GET");
        const media = pageMediaResponse(pathname.slice(PAGE_MEDIA_PATH.length), client);
        return media ?? jsonResponse({ error: { code: "not_found", message: "no such page media" } }, 404);
      }

      const workspaceResponse = await handleWorkspaceRequest(request, url, pathname, bunServer, broadcastAll, queueFirstMessage, () => {
        // the receipt first, then the roster read that can show it: not waited for, and its failure changes no answer
        const receipt = orderSequence.moved();
        void machines?.refreshLocal();
        return receipt;
      });
      if (workspaceResponse) return workspaceResponse;

      if (pathname === "/api/plugins/actions") {
        setRequestRoute(pathname);
        if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
        try {
          const [plugins, actions] = await Promise.all([pluginList(), pluginActionList()]);
          const body: PluginActionsResponse = {
            plugins: plugins.map((plugin) => ({
              plugin_id: plugin.plugin_id,
              name: plugin.name,
              version: plugin.version,
              description: plugin.description ?? null,
              enabled: plugin.enabled,
              // herdr lists another platform's actions too and refuses them: platform_unsupported
              actions: actions
                .filter((action) => action.plugin_id === plugin.plugin_id && (!action.platforms || action.platforms.includes(PLUGIN_PLATFORM)))
                .map((action) => ({ action_id: action.action_id, title: action.title, description: action.description ?? null, contexts: action.contexts ?? [] })),
            })),
          };
          return jsonResponse(body);
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/plugin/action" && request.method === "GET") {
        setRequestRoute(pathname);
        const pluginId = url.searchParams.get("plugin_id");
        const logId = url.searchParams.get("log_id");
        if (!pluginId) return badRequest("missing_plugin_id", "plugin_id is required");
        if (!logId) return badRequest("missing_log_id", "log_id is required");
        try {
          const log = await pluginLogEntry(logId, (limit) => pluginLogList(pluginId, limit));
          return jsonResponse(await pluginActionResult(log, () => livePaneIds()));
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/plugin/action") {
        setRequestRoute(pathname);
        if (request.method !== "POST") return badRequest("method_not_allowed", "use GET or POST");
        const payload = await readJsonObject<{ plugin_id?: unknown; action_id?: unknown; pane_id?: unknown }>(request);
        if (payload instanceof Response) return payload;
        if (typeof payload.plugin_id !== "string" || payload.plugin_id.length === 0) return badRequest("missing_plugin_id", "plugin_id is required");
        if (typeof payload.action_id !== "string" || payload.action_id.length === 0) return badRequest("missing_action_id", "action_id is required");
        if (payload.pane_id !== undefined && (typeof payload.pane_id !== "string" || payload.pane_id.length === 0)) return badRequest("invalid_pane_id", "pane_id must be a pane's ID");
        try {
          let context: PluginInvocationContext | undefined;
          if (payload.pane_id !== undefined) {
            const snapshot = await sessionSnapshot();
            const pane = snapshot.panes.find((entry) => entry.pane_id === payload.pane_id);
            // herdr would run the action with whatever ID it was handed
            if (!pane) throw new HerdrError("pane_not_found", `pane ${payload.pane_id} not found`);
            context = pluginPaneContext(snapshot, pane);
          }
          const pluginId = payload.plugin_id;
          const invoked = await pluginActionInvoke(pluginId, payload.action_id, context);
          return jsonResponse(await waitForPluginAction(
            invoked.log,
            options.pluginActionWaitMs ?? PLUGIN_ACTION_WAIT_MS,
            (timeoutMs) => pluginLogList(pluginId, PLUGIN_LOG_LIMIT, undefined, timeoutMs),
            livePaneIds,
          ));
        } catch (error) {
          return errorResponse(error);
        }
      }

      const paneResponse = await handlePaneRequest(request, url, pathname, options);
      if (paneResponse) return paneResponse;

      if (pathname === "/api/pane/omo-tasks") {
        setRequestRoute(pathname);
        if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
        const paneId = url.searchParams.get("pane_id");
        if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
        const session = omo.sessionOf(paneId);
        // server_time: the browser's clock can differ from this PC's, and the list says how long tasks ran
        const server_time = new Date().toISOString();
        if (session === null) {
          // a Claude pane's subagents, read from its session's files; nothing for any other pane.
          // Its transcript is found here if the background lookup has not got to it yet
          // (for a second at most: a slow herdr answers with what is known, and the next ask has the rest)
          // An unknown pane costs a fresh herdr lookup too; the client bounds its discovery retries.
          if (claudeAgents.sessionOf(paneId) === null) {
            await within(1000, (async () => {
              await claudeAgents.ensure(await paneGet(paneId));
            })());
          }
          const claude = claudeAgents.sessionOf(paneId);
          return jsonResponse({ tasks: claude === null ? [] : claudeSubagents(claude.path, claude.live, Date.now(), claude.startedAt), runs: [], server_time });
        }
        return jsonResponse({ tasks: omoTasks(session.cwd, session.sessionId, processAlive), runs: omoRuns(session.cwd, session.sessionId), server_time });
      }

      if (pathname === "/api/pane/plan") {
        setRequestRoute(pathname);
        if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
        const paneId = url.searchParams.get("pane_id");
        if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
        // the pane as herdr has it now, for a second at most: one the background lookup has not got to yet is looked
        // up here, and so is one that runs another session than the one its transcript was found for.
        // Herdr may name an OmO pane `claude`: use its resolved identity before looking up a plan.
        const seen: { pane?: HerdrPane } = {};
        await within(1000, (async () => {
          const pane = seen.pane = omo.apply(await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === paneId);
          if (pane === undefined || plans.known(pane)) return;
          if (pane.agent === "claude") await claudeAgents.ensure(pane);
          await plans.ensure(pane, true);
        })());
        // only the pane as herdr has it now is told its plan: one herdr did not answer for in time, no longer has, or has
        // in a session not looked up yet is told none, never the plan read before (session-plan.ts planOf)
        const steps = plans.planOf(seen.pane);
        const answer: PanePlan = { plan: steps === null ? null : { steps }, server_time: new Date().toISOString() };
        return jsonResponse(answer);
      }

      if (pathname === SESSION_HISTORY_PATH) {
        setRequestRoute(SESSION_HISTORY_PATH);
        return handleSessionHistoryRequest(request, url, { readOnly, stores: { codexHome: options.codexHome, opencodeDb: options.opencodeDb, hermesHome: options.hermesHome } });
      }

      if (pathname.startsWith("/api/pane/prompt")) {
        try {
          const response = await handlePromptRequest(request, url, { serialize, codexHome: options.codexHome, claudeTranscript: (paneId) => claudeAgents.sessionOf(paneId)?.path ?? null, readOnly, openCodeStateDir: options.openCodeStateDir, openCodeState });
          if (response) return response;
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname.startsWith("/api/")) {
        return jsonResponse({ error: { code: "not_found", message: `unknown endpoint ${pathname}` } }, 404);
      }

      // static client - public even when the API is gated, so the login UI can load
      setRequestRoute("static");
      return serveStatic(pathname, request.headers.get("accept-encoding"), requestOrigin(request));
      })());
      });
    },

    websocket: core.websocket,
  });

  const requestLog = new RequestLog(options.stateDir ?? defaultStateDir());

  if (options.portal) {
    // a Portal that ends on its own is started again only while this server's own token and serve-only allow it
    options.portal.authorize(portalGuards);
    let resume: Promise<void>;
    try {
      resume = options.portal.resume({ port: server.port ?? DEFAULT_PORT, ...portalGuards() });
    } catch (error) {
      resume = Promise.reject(error);
    }
    void resume.then(
      () => settlePortalStartup({ ok: true }),
      (error: unknown) => settlePortalStartup({ ok: false, error }),
    );
  } else {
    settlePortalStartup({ ok: true });
  }

  const registration = options.registerBridge ? registerBridge(server.port ?? 0, bridgeToken) : null;

  core.start();

  return {
    port: server.port ?? 0,
    hostname,
    statusReady: collector.ready,
    /** a create request's first message for a pane's agent, as the create routes queue it (server/core/pending.ts); for tests that run no agent */
    queueFirstMessage,
    alertsSettled: () => push.settled(),
    stop: () => {
      settlePortalStartup({ ok: false, error: new Error("Server stopped before Portal startup cleanup completed") });
      core.stop(() => {
        clearInterval(draftTimer);
        openCodeState.clear();
        void options.portal?.shutdown();
        registration?.close();
        closeCodexDaemonSources();
      });
      server.stop(true);
      requestLog.close();
    },
  };
}

if (import.meta.main) {
  moveLegacyStateDir();
  const updates = connectUpdater();
  const version = (JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string }).version;
  const telemetry = new Telemetry({ stateDir: defaultStateDir(), version, env: process.env, fetch, previousVersion: () => updates.installed().previous_version });
  const portal = new PortalService({ stateDir: defaultStateDir() });
  let instance: ReturnType<typeof createServer>;
  try {
    instance = createServer({ updates, herdrUpdate: new HerdrUpdater(), portal, telemetry, registerBridge: true, herdrProfiles: readHerdrProfiles });
  } catch (err) {
    const { code, syscall } = err as { code?: string; syscall?: string };
    // only the bind itself: a permission error reading a state file keeps its own message and path
    if (syscall !== "listen" || (code !== "EADDRINUSE" && code !== "EADDRNOTAVAIL" && code !== "EACCES")) throw err;
    const host = process.env["HOST"] ?? "127.0.0.1";
    const port = process.env["PORT"] || DEFAULT_PORT;
    const reason = code === "EADDRINUSE"
      ? `the port is in use. Another app (or Ovis) may already use it; start with another PORT=, or open http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${port} if it is this app`
      : code === "EADDRNOTAVAIL"
        ? "this PC has no such address; try HOST=127.0.0.1"
        : "the port needs permission; try a PORT above 1024";
    console.error(`Ovis cannot listen on ${host}:${port}: ${reason}.`);
    process.exit(1);
  }
  telemetry.start();
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    telemetry.stop();
    instance.stop();
    // Attach sidecars need ~1.2s to release herdr's exclusive client slot; Portal unregisters from
    // its relay, and the pipes it logs to must outlive it
    void Promise.all([Bun.sleep(2000), portal.shutdown()]).then(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  if (process.env["OVIS_MANAGED"] === "1") process.on("disconnect", shutdown);
  console.log(`Ovis listening on http://${instance.hostname}:${instance.port}`);
  const socket = herdrSocketPath();
  void ping(socket).catch(() => {
    console.error(`herdr is not reachable at ${socket}: start herdr, or set HERDR_SOCKET to its socket (named sessions: ~/.config/herdr/sessions/<name>/herdr.sock).`);
  });
  // the state folder is created on first write, so test the nearest folder that exists
  const stateDir = defaultStateDir();
  let probe = stateDir;
  while (true) {
    try {
      accessSync(probe, constants.F_OK);
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  try {
    accessSync(probe, constants.W_OK);
  } catch {
    console.error(`cannot write ${stateDir}: settings, devices and updates will not be saved; fix its permissions or set OVIS_STATE_DIR.`);
  }
  if (!isLoopbackBind(instance.hostname)) {
    if (lanExposed({ hostname: instance.hostname, tokenConfigured: (process.env["OVIS_TOKEN"] ?? "") !== "", gated: false })) {
      console.error(
        `WARNING: listening on ${instance.hostname} without OVIS_TOKEN - until a device is paired (Settings → Devices, on this PC) anyone who can reach this address can type into your terminals; pair your devices, set OVIS_TOKEN=<token>, or keep HOST=127.0.0.1 and reach it through Tailscale or an SSH tunnel.`,
      );
    }
    // The bind address says nothing about the transport: a token cookie and every keystroke
    // travel in the clear on plain http, so a listener on the same network gets them.
    if ((process.env["OVIS_TOKEN"] ?? "") !== "") {
      console.error(
        `WARNING: listening on http://${instance.hostname}:${instance.port} - OVIS_TOKEN is not confidential over cleartext http; on an untrusted network anyone who can read the traffic has the token and everything you type. Reach this PC over Tailscale, put it behind a TLS-terminating proxy, or keep HOST=127.0.0.1.`,
      );
    }
  }
}
