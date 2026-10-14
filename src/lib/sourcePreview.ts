import { SOURCE_PREVIEW_BYTES, SOURCE_PREVIEW_LINES, TEXT_PREVIEW_BYTES } from "./filePreviewText.ts";
import { countLines } from "./highlight.ts";
import { hasPreview } from "./textPreview.ts";

/**
 * Above this many lines a source is drawn by the virtualizer (VirtualSource): a window of rows
 * into the text, not an element per line. Below it the source stays `CodeLines`, colored on the
 * page or in the app's own worker, as the chat's code is.
 */
export const VIRTUAL_SOURCE_LINES = 2_000;

/**
 * A virtualized source is colored only up to these (characters, so a budget the text itself can be
 * measured against; lines). The virtualizer's highlighter colors the whole file in its worker and
 * keeps the result on the page: 8 MiB of JavaScript measured 55 s of worker time and 192 MB of
 * heap, so past these the rows are plain text, with the notice the header shows for code too long
 * to color.
 */
export const VIRTUAL_HIGHLIGHT_CHARS = 256 * 1024;
export const VIRTUAL_HIGHLIGHT_LINES = 5_000;

export type SourceLayout = "elements" | "virtual";

/** How a source of `lines` lines is drawn. */
export function sourceLayout(lines: number): SourceLayout {
  return lines > VIRTUAL_SOURCE_LINES ? "virtual" : "elements";
}

/** Whether a virtualized source of `chars` characters and `lines` lines is small enough to color. */
export function virtualHighlightable(chars: number, lines: number): boolean {
  return chars <= VIRTUAL_HIGHLIGHT_CHARS && lines <= VIRTUAL_HIGHLIGHT_LINES;
}

/** How much of a text file the viewer reads, and how long it waits for it. */
export interface ReadBudget {
  /** the Range asked for and the reader's byte limit */
  bytes: number;
  /** the reader's logical-line limit: the virtualizer's rows are bounded by it */
  lines: number;
  /** the fetch and read deadline */
  timeoutMs: number;
}

/**
 * The budget for a file of `size` bytes in `language`. A Markdown file keeps the Preview's budget,
 * which bounds its parse; its source is the same prefix. Any other text that fits the Preview's
 * budget reads it whole under it, and a larger one reads the source budget: more bytes take more
 * time, so its deadline is longer too. Every budget caps the lines, so a file of many short lines
 * is cut truthfully rather than handed to the viewer uncounted.
 */
export function readBudget(language: string | null, size: number): ReadBudget {
  if (hasPreview(language) || size <= TEXT_PREVIEW_BYTES) return { bytes: TEXT_PREVIEW_BYTES, lines: SOURCE_PREVIEW_LINES, timeoutMs: 5_000 };
  return { bytes: SOURCE_PREVIEW_BYTES, lines: SOURCE_PREVIEW_LINES, timeoutMs: 30_000 };
}

/**
 * The text as the viewer shows it. A cut prefix ends on a newline (the reader drops an incomplete
 * final line), and the row after that newline is not a line of the file: it would read as the
 * file's next line, blank, so it is not shown. A complete file keeps that row, its final empty line.
 */
export function shownSource(text: string, truncated: boolean): string {
  return truncated && text.endsWith("\n") ? text.slice(0, -1) : text;
}

/** Whether a requested source line can be marked, without pretending to jump to unseen text. */
export type LineRequest =
  | { readonly kind: "shown"; readonly line: number }
  | { readonly kind: "past-preview"; readonly line: number }
  | { readonly kind: "past-end"; readonly line: number; readonly lines: number };

/**
 * `source` is the text as shown (`shownSource`). For a cut prefix the lines there are the reader's
 * count of complete lines (`loadedLines`, newline-terminated records), never the row after its final
 * newline: the line just past the cap is unseen, not that row.
 */
export function lineRequest(line: number | null, source: string, truncated: boolean, loadedLines?: number): LineRequest | null {
  if (line === null) return null;
  const lines = truncated && loadedLines !== undefined ? loadedLines : countLines(source);
  if (line <= lines) return { kind: "shown", line };
  return truncated ? { kind: "past-preview", line } : { kind: "past-end", line, lines };
}
