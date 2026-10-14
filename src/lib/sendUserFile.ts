/** A `SendUserFile` call's input, read for the chat: its caption and the files it names. */
export interface SendUserFileCall {
  caption: string;
  files: string[];
}

/**
 * A `SendUserFile` tool call's input (`files`, `caption`, `display`), or null when the input is
 * no such call: no `files` array, or one with no usable path left once a non-string or blank
 * entry is dropped. The caption is trimmed and empty when absent or blank, never a reason by
 * itself to read the call as something else.
 */
export function sendUserFileCall(input: Record<string, unknown>): SendUserFileCall | null {
  if (!Array.isArray(input["files"])) return null;
  const files = input["files"].filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (files.length === 0) return null;
  const caption = typeof input["caption"] === "string" ? input["caption"].trim() : "";
  return { caption, files };
}
