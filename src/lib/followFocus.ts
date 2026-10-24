import { paneStorageId } from "../../shared/machines.ts";
import { composerDrafts } from "./composerDraft.ts";
import { restoreDraft } from "./draft.ts";
import { readTerminalDraft } from "./terminalDraft.ts";
import { sameTarget, type SplitTarget } from "./split.ts";

/**
 * Following herdr's focus (Settings → Terminal, `followHerdrFocus`, #311): herdr's own window
 * moves to the pane a click there, `herdr tab focus` or a script brings to the front, and a
 * `pane-focused` frame says so. This device opens that pane too, only when it asked to and only on
 * the PC it has open: another PC's focus is that PC's business, and a pane already in front (the
 * selected one, or the other half of a split) stays where it is. A link still landing goes first,
 * and someone using this device (`busy`, deviceInUse) keeps the pane they are on.
 */
export function followsHerdrFocus(input: {
  enabled: boolean;
  /** the PC and pane the frame names */
  machineId: string;
  paneId: string;
  selection: { machineId: string; paneId: string | null };
  /** the split's other half, while it is drawn */
  splitOther: SplitTarget | null;
  linkPending: boolean;
  /** this device is in use: following would drop the keyboard, close what is open or leave an unsent message (#1470) */
  busy: boolean;
}): boolean {
  if (!input.enabled || input.linkPending || input.busy) return false;
  if (input.machineId !== input.selection.machineId || input.paneId === input.selection.paneId) return false;
  return !sameTarget(input.splitOther, { machineId: input.machineId, paneId: input.paneId });
}

/**
 * A dialog is open over the pane, or the keyboard is in a text field (the composer, the input line,
 * the terminal's own): following herdr's focus would close the dialog or drop the keyboard
 * mid-sentence. Only a window in front counts (deviceInUse).
 */
export function deviceBusy(doc: Pick<Document, "activeElement" | "querySelector"> = document): boolean {
  if (doc.querySelector('[aria-modal="true"], dialog[open]') !== null) return true;
  const active = doc.activeElement;
  return active !== null && "matches" in active
    && active.matches("textarea, input, select, [contenteditable]:not([contenteditable='false'])");
}

/** The unsent text each of a pane's three drafts holds, by its owner (paneStorageId). */
export interface PaneDrafts {
  /** the chat composer's (ovis:composer-draft:) */
  composer: (owner: string) => string;
  /** the terminal input line's on a touch screen (ovis:terminal-line:) */
  line: (owner: string) => string;
  /** what the terminal held when its connection dropped, waiting for Send or Discard (ovis:terminal-draft:) */
  held: (owner: string) => string;
}

const draftsHere: PaneDrafts = {
  composer: (owner) => composerDrafts.read(`ovis:composer-draft:${owner}`).text,
  line: (owner) => readTerminalDraft(owner),
  held: (owner) => {
    let raw: string | null = null;
    try { raw = localStorage.getItem(`ovis:terminal-draft:${owner}`); } catch { /* private mode */ }
    return restoreDraft(raw, Date.now()).text;
  },
};

/**
 * The pane this device has open holds an unsent message in any of its drafts: following would
 * leave it behind, so the pane stays until it is sent or cleared.
 */
export function unsentDraft(selection: { machineId: string; paneId: string | null }, drafts: PaneDrafts = draftsHere): boolean {
  if (selection.paneId === null) return false;
  const owner = paneStorageId(selection.machineId, selection.paneId);
  return [drafts.composer(owner), drafts.line(owner), drafts.held(owner)].some((text) => text.trim() !== "");
}

/**
 * Someone is using this device on the pane it has open (#1470): its window is in front and it is
 * busy there (deviceBusy) or holds an unsent message on the pane (unsentDraft). A window in the
 * background is not in use, whatever it has open or kept: its reader is in herdr's own window,
 * the case following herdr's focus is for.
 */
export function deviceInUse(
  selection: { machineId: string; paneId: string | null },
  doc: Pick<Document, "activeElement" | "hasFocus" | "querySelector"> = document,
  drafts: PaneDrafts = draftsHere,
): boolean {
  return doc.hasFocus() && (deviceBusy(doc) || unsentDraft(selection, drafts));
}
