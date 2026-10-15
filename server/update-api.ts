import { noInstalledNotes, noUpdateNotes, readInstalledNotes, readUpdateNotes, unmanagedUpdateStatus, type InstalledNotes, type UpdateCommand, type UpdateNotes, type UpdateStatus } from "../shared/update.ts";
import { join } from "node:path";
import { jsonResponse } from "./http.ts";

export interface UpdateService {
  status(): UpdateStatus;
  /** what the available update brings, from the supervisor's last check */
  notes(): UpdateNotes;
  /** what the last update brought, from the supervisor that runs it */
  installed(): InstalledNotes;
  request(command: UpdateCommand): void;
  /** The commit the client build in the served `dist/` was made from (see `servedRevision`); absent when unmanaged. */
  servedRevision?(): Promise<string | null>;
}

/**
 * The commit the client build in `<directory>/dist` was made from, read from the `build.json` the
 * build writes (vite.config.ts) each time a tab asks. The bridge serves `dist/` from its directory
 * on every request, so a source checkout rebuilt under it (a plugin reinstall, or `git pull` and a
 * build) is served at once while the server still runs the revision it started with: a tab
 * reloaded then must already be told that only a restart helps. Only a build written after
 * `since` (the bridge's start) counts: one already there was not replaced under the server, and a
 * restart would not change it (a pull without a build, then a restart). A build older than the
 * file, or outside Git, answers null too.
 */
export function servedRevision(directory: string, since = Date.now()): () => Promise<string | null> {
  const file = join(directory, "dist", "build.json");
  return async () => {
    try {
      const build = Bun.file(file);
      if (build.lastModified < since) return null;
      const revision = (await build.json() as { revision?: unknown }).revision;
      return typeof revision === "string" && /^[0-9a-f]{40,64}$/.test(revision) ? revision : null;
    } catch { return null; }
  };
}

/** Only the managed entrypoint connects IPC; importing createServer in tests does not. */
export function connectUpdater(): UpdateService {
  let status = unmanagedUpdateStatus();
  let notes = noUpdateNotes();
  let installed = noInstalledNotes();
  const managed = Boolean(process.send) && process.env["HERDR_WEB_MANAGED"] === "1";
  if (managed) {
    process.on("message", (message: unknown) => {
      const value = message as { type?: string; status?: UpdateStatus; notes?: unknown; installed?: unknown };
      if (value?.type !== "update-status" || !value.status) return;
      status = value.status;
      // a supervisor older than the notes sends none: the one being replaced, or a fallback
      notes = readUpdateNotes(value.notes);
      installed = readInstalledNotes(value.installed);
    });
    process.send?.({ type: "update-status-request" });
  }
  return {
    status: () => status,
    notes: () => notes,
    installed: () => installed,
    request: (command) => process.send?.({ type: "update-command", command }),
    // the supervisor starts the bridge in the directory it serves: the release's, or the source checkout
    ...(managed ? { servedRevision: servedRevision(process.cwd()) } : {}),
  };
}

/**
 * Whether an update POST came from this app's own controls. A custom header is not
 * submit-able by an HTML form. Cross-origin preflights are refused (no CORS headers);
 * Sec-Fetch-Site also rejects browser CSRF.
 */
export function updateRequestAllowed(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  let sameHost = true;
  try { if (origin) sameHost = new URL(origin).host === url.host; } catch { sameHost = false; }
  return request.headers.get("x-herdr-update") === "1" && sameHost && (site === null || site === "same-origin") && !url.search;
}

/**
 * The status with `served_revision`: the commit of the client build a reload loads, once it differs
 * from the revision the server runs; null while they match or the build names none.
 */
async function withServed(status: UpdateStatus, service?: UpdateService): Promise<UpdateStatus> {
  if (!status.managed || !status.current_revision || !service?.servedRevision) return status;
  const served = await service.servedRevision();
  return { ...status, served_revision: served !== null && served !== status.current_revision ? served : null };
}

export function handleUpdateRequest(request: Request, pathname: string, service?: UpdateService): Response | Promise<Response> {
  const status = service?.status() ?? unmanagedUpdateStatus();
  const reply = (body: unknown, code = 200) => {
    const response = jsonResponse(body, code);
    response.headers.set("cache-control", "no-store");
    return response;
  };
  const fail = (code: string, message: string, http: number) => reply({ error: { code, message } }, http);
  if (pathname === "/api/updates" && request.method === "GET") return withServed(status, service).then((value) => reply(value));
  if (pathname === "/api/updates/notes" && request.method === "GET") return reply(service?.notes() ?? noUpdateNotes());
  if (pathname === "/api/updates/installed" && request.method === "GET") return reply(service?.installed() ?? noInstalledNotes());
  if (request.method !== "POST" || (pathname !== "/api/updates/check" && pathname !== "/api/updates/install")) {
    return fail("method_not_allowed", "Use GET /api/updates, /api/updates/notes or /api/updates/installed, or POST /api/updates/check or /install", 405);
  }
  if (!updateRequestAllowed(request)) return fail("invalid_update_request", "Use the update controls from this app.", 403);
  if (!service || !status.managed) return fail("updates_unmanaged", status.blocked_reason ?? "Updates unavailable", 409);
  if (["checking", "building", "restarting"].includes(status.phase)) return fail("update_busy", "An update operation is already running.", 409);
  if (pathname.endsWith("/install") && (status.blocked_reason || !status.available)) {
    return fail("update_unavailable", status.blocked_reason ?? "No update is available. Check again first.", 409);
  }
  service.request(pathname.endsWith("/check") ? "check" : "install");
  return reply({ accepted: true }, 202);
}
