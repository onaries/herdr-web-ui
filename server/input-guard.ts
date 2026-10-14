/**
 * Whether typing taken while `origin` was the pane's attachment may still be written: into
 * the same attach, which still has the typist, or (taken with no attach) into a pane nobody
 * has attached since. An attach that came while the typing waited is someone else's screen.
 */
export function sameAttachment<Client, Attachment extends { clients: { has(client: Client): boolean } }>(
  origin: Attachment | undefined, current: Attachment | undefined, client: Client,
): boolean {
  return origin ? current === origin && origin.clients.has(client) : current === undefined;
}

/** One or more mouse reports as xterm sends them: SGR (`CSI < b ; x ; y M|m`) or the default `CSI M` plus three bytes. */
const MOUSE_REPORTS = /^(?:\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3})+$/;

/**
 * Whether `text` is nothing but mouse reports (a click, a wheel). The attach input reads them as
 * the terminal's mouse and encodes them for the program's own mouse mode, while `pane.send_text`
 * would type their bytes literally into a program that may never have asked for them (#667).
 */
export function isMouseReport(text: string): boolean {
  return MOUSE_REPORTS.test(text);
}
