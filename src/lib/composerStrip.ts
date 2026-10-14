/**
 * The slim strip tucked under the input card (Composer.tsx): the pane's working folder and its
 * branch, as t3code's composer names its checkout and branch in a strip under the composer. Each
 * part is drawn only when the caller passes it (the composer takes them as optional props); a
 * blank string counts as absent, and with neither part there is no strip at all.
 */
import { folderName } from "./paneName.ts";

export interface ComposerStrip {
  /** the working folder's last name, as the greeting names it; `path` keeps the whole path */
  folder: string | null;
  path: string | null;
  branch: string | null;
}

/** What the strip draws, or null when there is nothing to draw. */
export function composerStrip(input: { cwd?: string | null | undefined; branch?: string | null | undefined }): ComposerStrip | null {
  const path = input.cwd !== undefined && input.cwd !== null && input.cwd.trim() !== "" ? input.cwd : null;
  const branch = input.branch !== undefined && input.branch !== null && input.branch.trim() !== "" ? input.branch.trim() : null;
  if (path === null && branch === null) return null;
  return { folder: path === null ? null : folderName(path), path, branch };
}
