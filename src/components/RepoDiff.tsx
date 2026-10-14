import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_VIRTUAL_FILE_METRICS, parsePatchFiles, trimPatchContext, type FileDiffMetadata } from "@pierre/diffs";
import { FileDiff, Virtualizer, type FileDiffOptions } from "@pierre/diffs/react";

import { DiffWorkerPool } from "./DiffWorkerPool.tsx";
import { useT } from "../lib/i18n.ts";
import type { DiffStyle } from "../lib/settings.ts";
import { VIRTUAL_HIGHLIGHT_LINES } from "../lib/sourcePreview.ts";
import { contentKey, keepEmptyRows, SCROLL_CONFIG, SHADOW_CSS, SOURCE_THEME } from "../lib/sourceTheme.ts";
import "./RepoDiff.css";

export interface RepoDiffProps {
  /** git's patch for one file, from its `diff --git` line on, whole */
  patch: string;
  style: DiffStyle;
  /** one unchanged line around each change instead of the three git printed; the rest counts in the separators */
  folded: boolean;
  wrap: boolean;
  theme: "dark" | "light";
  /** colored in the pool's worker; false draws plain rows, still windowed by the pool's manager (the setting off, or too long, which the host says) */
  colored: boolean;
}

/** The fewest context lines the package's trimmer keeps correct (at 0 it miscounts the lines it drops). */
export const FOLDED_CONTEXT_LINES = 1;

/**
 * The diff colors on top of the source theme: the app's inserted/deleted tokens as the package's
 * base colors. Its gutter bars, signs and word emphasis take them verbatim, and it mixes the row
 * backgrounds from them and the app's background itself (an override here would be mixed again).
 */
const DIFF_SHADOW_CSS = `${SHADOW_CSS}
:host {
  --diffs-light-addition-color: var(--syntax-inserted);
  --diffs-dark-addition-color: var(--syntax-inserted);
  --diffs-light-deletion-color: var(--syntax-deleted);
  --diffs-dark-deletion-color: var(--syntax-deleted);
  --diffs-bg-separator-override: var(--bg-elevated);
  --diffs-bg-context-override: var(--bg);
  --diffs-bg-context-gutter-override: var(--bg);
  --diffs-header-font-family: var(--font-ui);
}
`;

type Options = FileDiffOptions<undefined, undefined>;

/** Pierre's reading of the patch: its one file, parsed strictly so a form it does not read fails here, not in a row. */
function parseFile(text: string): FileDiffMetadata | null {
  return parsePatchFiles(text, contentKey("repo-diff", text), true)[0]?.files[0] ?? null;
}

/**
 * One file's diff as a window of rows from the package's virtualizer, unified or split, with the
 * old and new line numbers in its gutters and the unchanged lines between hunks counted in its
 * separators. The parsed diff keeps its identity while the patch and the fold are unchanged, as
 * the virtualizer renders by identity, and its host fills the scroll root so it has a box before
 * the first anchor pass (the contracts VirtualSource measured).
 */
export default function RepoDiff({ patch, style, folded, wrap, theme, colored }: RepoDiffProps) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const [lineHeight, setLineHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const measured = Number.parseFloat(getComputedStyle(host).lineHeight);
    setLineHeight(Number.isFinite(measured) && measured > 0 ? measured : DEFAULT_VIRTUAL_FILE_METRICS.lineHeight);
  }, []);

  const text = useMemo(() => (folded ? trimPatchContext(patch, FOLDED_CONTEXT_LINES) : patch), [patch, folded]);
  const fileDiff = useMemo(() => parseFile(text), [text]);
  const onPostRender = useCallback<NonNullable<Options["onPostRender"]>>((node, _instance, phase) => {
    if (phase !== "unmount" && node.shadowRoot !== null) keepEmptyRows(node.shadowRoot);
  }, []);
  const options = useMemo<Options>(() => ({
    disableFileHeader: true,
    diffStyle: style,
    hunkSeparators: "line-info",
    overflow: wrap ? "wrap" : "scroll",
    theme: SOURCE_THEME,
    themeType: theme,
    tokenizeMaxLength: colored ? VIRTUAL_HIGHLIGHT_LINES : 0,
    lineHoverHighlight: "disabled",
    enableLineSelection: false,
    unsafeCSS: DIFF_SHADOW_CSS,
    onPostRender,
  }), [style, wrap, theme, colored, onPostRender]);
  const metrics = useMemo(() => (lineHeight === null ? null : { ...DEFAULT_VIRTUAL_FILE_METRICS, lineHeight }), [lineHeight]);

  if (fileDiff === null || fileDiff.hunks.length === 0) return <p className="repo-diff-note">{t("No lines changed.")}</p>;
  // plain rows go through the pool too, though they never reach a worker (tokenizeMaxLength 0 keeps
  // the diff massive, so no highlight is queued): without one the package builds rows for every line
  // of the diff on the page, again on each render (each scroll), where the pool's manager builds
  // only the window's rows. The 10 000-line diff held the page 130-270 ms per scroll step that way
  // at a 4x CPU slowdown.
  return <div ref={hostRef} className="repo-diff" data-style={style} data-colored={colored ? "" : undefined} data-folded={folded ? "" : undefined}>
    <DiffWorkerPool>
      <Virtualizer className="repo-diff-scroll" contentClassName="repo-diff-column" config={SCROLL_CONFIG}>
        {metrics !== null && <FileDiff className="repo-diff-file" fileDiff={fileDiff} options={options} metrics={metrics} />}
      </Virtualizer>
    </DiffWorkerPool>
  </div>;
}
