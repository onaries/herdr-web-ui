/**
 * Hermes ignores a lone Escape; its interrupt is Ctrl+C, and that same key exits an idle Hermes
 * (measured on Hermes 0.21.5, classic CLI and TUI) and force-quits the classic CLI on a second
 * press within 2 s. So Stop sends one Ctrl+C, and only while Hermes' own input row says a turn
 * is running: the classic CLI's `msg=interrupt · /queue · … · Ctrl+C cancel` or the TUI's
 * `Ctrl+C to interrupt…`.
 *
 * Only the bottom-most `❯` row is read: a message echoed in the transcript sits above it, so
 * quoted hint text there never counts. A draft typed into Hermes hides the hint, and Stop then
 * sends nothing rather than guess.
 */
export function hermesInterruptible(rows: readonly string[]): boolean {
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
    // the row's first `❯` is the prompt: one after it is text typed into the input
    const at = row.indexOf("❯");
    if (at < 0) continue;
    const input = row.slice(at + 1).trim();
    return /^msg=\w+ · .*Ctrl\+C cancel$/.test(input) || /^Ctrl\+C to interrupt(?:…|\.\.\.)$/.test(input);
  }
  return false;
}

/** Hermes force-quits the classic CLI on a second Ctrl+C within this window of the first. */
export const HERMES_CTRL_C_WINDOW_MS = 2000;

/**
 * True while a Ctrl+C sent at `lastCtrlCAt` is still inside Hermes' force-quit window. Status
 * flicker or a quick new turn resets the per-turn guard, so the time of the last Ctrl+C decides.
 */
export function hermesCtrlCTooSoon(lastCtrlCAt: number | null, now: number): boolean {
  return lastCtrlCAt !== null && now - lastCtrlCAt < HERMES_CTRL_C_WINDOW_MS;
}

/** The key Chat's Stop sends: Escape for every agent but Hermes, one Ctrl+C or nothing for Hermes. */
export function stopKey(
  agent: string | null | undefined,
  rows: () => readonly string[],
  sentThisTurn: boolean,
  lastCtrlCAt: number | null,
  now: number,
): "\u001b" | "\u0003" | null {
  if (agent !== "hermes") return "\u001b";
  if (sentThisTurn || hermesCtrlCTooSoon(lastCtrlCAt, now)) return null;
  return hermesInterruptible(rows()) ? "\u0003" : null;
}
