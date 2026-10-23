/**
 * Ovis read its settings from HERDR_WEB_* variables before the rename to OVIS_*. Installs keep
 * those in herdr's plugin env file, shell profiles and service units, so each one still works:
 * an OVIS_* variable that is not set takes the value of its old name, and one that is set wins.
 * Entry points apply it to their own environment through adopt-legacy-env.ts.
 */
import { homedir } from "node:os";
import { join } from "node:path";

const LEGACY_PREFIX = "HERDR_WEB_";
/** old names that do not map by prefix alone */
const RENAMED: Record<string, string> = { HERDR_WEB_UI_REF: "OVIS_REF" };

/** The OVIS_* name an old HERDR_WEB_* variable now goes by, or null for any other name. */
export function ovisName(legacy: string): string | null {
  if (!legacy.startsWith(LEGACY_PREFIX)) return null;
  return RENAMED[legacy] ?? `OVIS_${legacy.slice(LEGACY_PREFIX.length)}`;
}

/** The old name an OVIS_* setting went by, or null for any other name. */
export function legacyName(name: string): string | null {
  if (!name.startsWith("OVIS_")) return null;
  return Object.keys(RENAMED).find((legacy) => RENAMED[legacy] === name) ?? `${LEGACY_PREFIX}${name.slice("OVIS_".length)}`;
}

/** `settings` under their old names as well, for a bridge from before the rename to read. */
export function withLegacyNames(settings: Record<string, string>): Record<string, string> {
  const both = { ...settings };
  for (const [name, value] of Object.entries(settings)) {
    const legacy = legacyName(name);
    if (legacy !== null) both[legacy] = value;
  }
  return both;
}

/** Fills each unset OVIS_* variable from its old name, in place. */
export function adoptLegacyEnv(env: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(env)) {
    const next = ovisName(name);
    if (next !== null && value !== undefined && env[next] === undefined) env[next] = value;
  }
}

/**
 * The state dir of the launcher (server/managed.ts) that started this supervisor, when that
 * launcher is from before the rename; null under a launcher of this version (which sets
 * OVIS_LAUNCHER) or none. An update never replaces a running launcher, and the old one looks for
 * the active release only under its own state dir, so a supervisor it starts keeps the state there.
 */
export function legacyLauncherStateDir(env: Record<string, string | undefined>): string | null {
  if (env["OVIS_LAUNCHER"] !== undefined || env["HERDR_WEB_SOURCE_ROOT"] === undefined) return null;
  return env["HERDR_WEB_STATE_DIR"] || join(env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "herdr-web-ui");
}

/**
 * Merges environment layers in order, a later one winning, each mapped on its own first: an old
 * name set in a later layer (a settings file) wins over the new name an earlier layer (the
 * parent's environment) got from its own old name.
 */
export function mergeEnvLayers(layers: Record<string, string | undefined>[]): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = {};
  for (const layer of layers) {
    const own = { ...layer };
    adoptLegacyEnv(own);
    Object.assign(merged, own);
  }
  return merged;
}
