/**
 * The order of this server's workspaces as one counter per server lifetime (createServer makes one).
 * A confirmed `workspace.move` takes the next number; a session read takes the number current when
 * it starts, before it waits on herdr. A read that started before a move therefore carries a smaller
 * number than the move's receipt, however late it is delivered or what any clock says. The epoch is
 * this server's own boot id (`web_ui.boot_id` of /api/health): a restart starts a new epoch at 0, and
 * nothing of the counter is saved. Numbers compare only within one epoch.
 */
export interface ReadEvidence { order_epoch: string; read_seq: number }
export interface MoveReceipt { order_epoch: string; moved_seq: number }

export class OrderSequence {
  private seq = 0;
  constructor(readonly epoch: string) {}
  /** at a session read's start: the number of moves confirmed so far */
  read(): ReadEvidence { return { order_epoch: this.epoch, read_seq: this.seq }; }
  /** a move herdr confirmed: its own number, taken before anything else is awaited */
  moved(): MoveReceipt { return { order_epoch: this.epoch, moved_seq: ++this.seq }; }
}
