import type { Terminal } from "@xterm/xterm";
import { HERDR_MOUSE_SCROLL_LINES } from "./wheelSteps.ts";

/** Live settings/status read by the handler attached once for a terminal's lifetime. */
export interface TerminalWheelState {
  readonly speed: number;
  readonly omoQuestion: boolean;
}

interface WheelViewport {
  /** A selecting drag owns its wheel before any application routing. */
  readonly drag: (event: WheelEvent) => boolean;
  readonly adopted: () => boolean;
  readonly scroll: (lines: number) => void;
}

/** herdr owns history; xterm owns encoding mouse reports for applications that use them. */
export function attachTerminalWheel(term: Terminal, state: { readonly current: TerminalWheelState }, viewport: WheelViewport): void {
  term.attachCustomWheelEventHandler((event) => {
    if (viewport.drag(event)) return false;
    // Observed/fixed grids pan in the browser instead of changing herdr's viewport.
    if (viewport.adopted()) return false;
    if (term.hasSelection()) term.clearSelection();
    // OmO consumes wheel reports without acting while a question captures mouse input, so the
    // wheel moves herdr's history itself, as far as the reports below would: one three-line step
    // per event whatever its delta, repeated at the chosen speed for a real wheel only.
    if (state.current.omoQuestion && !event.ctrlKey && !event.shiftKey) {
      event.preventDefault();
      if (event.deltaY !== 0) viewport.scroll(-Math.sign(event.deltaY) * HERDR_MOUSE_SCROLL_LINES * (event.isTrusted ? state.current.speed : 1));
      return false;
    }
    const reporting = term.modes.mouseTrackingMode !== "none";
    // A program that does not report must not receive xterm's fallback arrow keys.
    // Trusted wheels replay at the chosen speed; touch/replays already supply their steps.
    // A trackpad pinch (Ctrl) keeps its original single-event path and all replayed modifiers.
    if (reporting && event.isTrusted && event.target && !event.ctrlKey) {
      for (let sent = 1; sent < state.current.speed; sent += 1) {
        event.target.dispatchEvent(new WheelEvent("wheel", {
          bubbles: true, cancelable: true, deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode,
          clientX: event.clientX, clientY: event.clientY,
          ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey,
        }));
      }
    }
    return reporting;
  });
}
