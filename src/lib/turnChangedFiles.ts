import type { ConversationPart } from "../../shared/protocol.ts";
import { patchFiles, patchText } from "../../shared/patch.ts";
import { toolVerbKind } from "./toolVerbs.ts";

/** Paths explicitly named by successful edit calls, never inferred from narration or output. */
export function turnChangedFiles(parts: readonly ConversationPart[]): string[] {
  const files = new Set<string>();
  for (const part of parts) {
    if (part.kind !== "tool" || part.error || part.arguments_omitted) continue;
    const kind = toolVerbKind(part.name, part.input);
    if (kind !== "edit" && kind !== "write") continue;
    let patch = patchText(part.input);
    if (patch === null) {
      let args: unknown;
      try { args = JSON.parse(part.input); }
      catch (error) { if (error instanceof SyntaxError) continue; throw error; }
      if (args === null || typeof args !== "object") continue;
      for (const key of ["file_path", "notebook_path", "path"] as const) {
        if (key in args) {
          const path = Reflect.get(args, key);
          if (typeof path === "string" && path.trim().length > 0) files.add(path.trim());
        }
      }
      for (const key of ["patch", "input"] as const) {
        if (key in args) {
          const value = Reflect.get(args, key);
          if (typeof value === "string") patch = patchText(value);
          if (patch !== null) break;
        }
      }
    }
    if (patch !== null) {
      for (const file of patchFiles(patch)) files.add(file);
      for (const move of patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) {
        const path = move[1]?.trim();
        if (path) files.add(path);
      }
    }
  }
  return [...files];
}

/** The diff API takes a root-relative path; tools name absolute or pane-relative paths. */
export function repositoryTurnPath({ path, cwd, root }: { path: string; cwd: string | null; root: string }): string | null {
  if (path.startsWith("~")) return null;
  const normalized = (value: string): string => {
    const segments: string[] = [];
    for (const segment of value.replaceAll("\\", "/").split("/")) {
      if (segment === "." || segment === "") continue;
      if (segment === "..") segments.pop(); else segments.push(segment);
    }
    return `${value.startsWith("/") ? "/" : ""}${segments.join("/")}`;
  };
  const absolute = /^(?:\/|[A-Za-z]:[\\/])/.test(path) ? path : `${cwd ?? root}/${path}`;
  const target = normalized(absolute);
  const folder = normalized(root).replace(/\/$/, "");
  const windows = /^[A-Za-z]:/.test(folder);
  const prefix = `${folder}/`;
  if (!(windows ? target.toLowerCase().startsWith(prefix.toLowerCase()) : target.startsWith(prefix))) return null;
  return target.slice(prefix.length) || null;
}
