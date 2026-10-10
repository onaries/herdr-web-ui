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
