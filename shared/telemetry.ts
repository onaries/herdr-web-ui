/**
 * Anonymous install and update counts (server/telemetry.ts). On by default after a one-time
 * notice in the app; nothing is sent before that notice was shown (and a grace period after it,
 * server/telemetry.ts NOTICE_GRACE_MS), and nothing between an install and an update. An event
 * also names the appearance settings changed from their defaults (REPORTED_SETTINGS): the browser
 * tells its server which, and the server keeps the last answer for its next event.
 *
 *  GET  /api/telemetry  -> TelemetryStatus, no-store
 *  POST /api/telemetry  { enabled?: boolean, notice_seen?: true, changed_settings?: ReportedSetting[] } -> TelemetryStatus
 *       (same-origin, `x-herdr-update: 1`)
 *
 * A server that sends nothing (tests, a remote PC's bridge, an older server) answers 404 to
 * both, and the app shows neither the notice nor the switch.
 */

export type TelemetryEventName = "install" | "update";

/**
 * The notice's wording as a number: an install that saw an older one sees the notice again, and
 * sends nothing until it has (2: the event names changed appearance settings).
 */
export const NOTICE_VERSION = 2;

/**
 * The settings an event may name as changed from their defaults. Choices from a fixed set only:
 * never one the user types (a font, a shortcut, the key bar), and only the name, not the value.
 */
export const REPORTED_SETTINGS = ["theme", "density", "palette", "sidebarRows", "agentOrder", "agentCards", "agentPins"] as const;
export type ReportedSetting = typeof REPORTED_SETTINGS[number];
/** Settings that were removed: a saved state or a page loaded before the update may still name
 * them, so they are accepted and dropped, never refused or sent. */
export const RETIRED_SETTINGS: readonly string[] = ["planFlow", "planButton"];

/** A list of reported settings in their own order, each once; null when the value is not one. */
export function reportedSettings(value: unknown): ReportedSetting[] | null {
  if (!Array.isArray(value) || value.some((name) => !(REPORTED_SETTINGS as readonly unknown[]).includes(name) && !RETIRED_SETTINGS.includes(name))) return null;
  return REPORTED_SETTINGS.filter((name) => value.includes(name));
}
export type InstallMethod = "plugin" | "managed" | "source";

/**
 * One event, exactly as it is sent. The receiver keeps these fields, the day and the country the
 * request came from (two characters, worked out by its host); no IP, no address.
 */
export interface TelemetryEvent {
  event: TelemetryEventName;
  /** random, made on this PC the first time; says nothing about the user */
  install_id: string;
  /** the running app's version, without the v */
  version: string;
  /** the version an update replaced; null for an install, or an update from before telemetry */
  previous_version: string | null;
  /** Node's `process.platform` and `process.arch` */
  os: string;
  arch: string;
  install_method: InstallMethod;
  /** the appearance settings changed from their defaults in the browser that last opened the app; null before one has told */
  changed_settings: ReportedSetting[] | null;
}

export interface TelemetryStatus {
  /** the switch in Settings */
  enabled: boolean;
  /** HERDR_WEB_TELEMETRY=0, DO_NOT_TRACK or a CI/test environment: nothing is sent whatever the switch says */
  blocked_by_env: boolean;
  /** the app has shown its current notice (NOTICE_VERSION) once; no event goes out before that */
  notice_seen: boolean;
  /** what the next event would be, as it would be sent; null when there is nothing left to send for this version */
  next: TelemetryEvent | null;
}
