import { join } from "node:path";

/** herdr's own state dir (its config/io.rs state_dir()), under which it keeps each plugin's state */
export function herdrStateDir(env: Record<string, string | undefined>, os: string, home: string): string {
  const xdg = env["XDG_STATE_HOME"];
  if (xdg !== undefined) return join(xdg, "herdr");
  if (os === "win32") return join(env["LOCALAPPDATA"] ?? join(env["USERPROFILE"] ?? home, "AppData", "Local"), "herdr");
  return join(home, ".local", "state", "herdr");
}
