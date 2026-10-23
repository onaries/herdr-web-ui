import { HerdrSocket } from "./ws.ts";
import { userErrorMessage } from "./userError.ts";

/** How long a resize must rest before the grid refits and the pty follows it. */
export const RESIZE_SETTLE_MS = 120;
/** How long a tab is out of use before it lets go of its pane: a glance at another window keeps it. */
export const RELEASE_AFTER_MS = 1000;

// Only a tab the user is in drives the shared grid. A window left open behind another app
// still turns visible when the screen wakes, and reconnects, reloads or moves on to the next pane
// in the background: taking the pane then sized it for nobody, and herdr's own TUI drew it cut
// off at its split's edge
export const inUse = (): boolean => document.visibilityState === "visible" && document.hasFocus();

/** The PC sockets this page has been connected to (lib/machineSession.ts keeps one per PC, across pane
    views and terminal mounts): not connected on one of them, a terminal is reconnecting; on any other, it
    is connecting for the first time. The words say which (here, ChatView and the header's chip). */
export const connectedSockets = new WeakSet<HerdrSocket>();

/** A failure as one line: the plain sentence, then what the server or the browser said. */
export const plainError = (cause: unknown): string => {
  const failure = userErrorMessage(cause);
  return failure.detail === null ? failure.message : `${failure.message} (${failure.detail})`;
};

export type StillOpen = { pane: string; agent: string; command: string; named: boolean; history: string | undefined };
