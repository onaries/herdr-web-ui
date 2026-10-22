/**
 * What the header says about a PC's herdr, kept apart from what that herdr can do.
 *
 * A health read that fails is no proof that herdr stopped: the web server may be restarting, the
 * phone may have dropped a request, herdr may be busy for one poll. So one failed read in a row
 * makes the status unknown (the last answer's details stay named), and a second makes it
 * unavailable. Neither changes the PC's capabilities: those are the last answer the PC gave, and
 * only another answer replaces them, so a Windows herdr's `terminal_attach: false` is never
 * forgotten into the attach-capable default by a failed read. Reads are numbered as they start. An
 * answer is taken in unless a newer answer already was, even after a newer read failed: what the PC
 * can do never waits on the order its reads fail in. The run of failures is the failed reads newer
 * than the answer taken in, whatever order they complete in: an answer that lands late ends the
 * failures before it and keeps the ones after it, and a failure older than that answer never counts.
 */

export type HealthFreshness = "pending" | "fresh" | "unknown" | "unavailable";
export type HealthAnswer<T> = { ok: true; value: T } | { ok: false };

export interface MachineHealth<T> {
  /** the PC's latest answer: its capabilities, until another answer replaces them */
  readonly confirmed: T | null;
  /** failed reads newer than that answer (or since the page opened), counted up to UNAVAILABLE_AFTER */
  readonly failures: number;
  /** the read that brought `confirmed`; an older read that completes later, failed or answered, is dropped */
  readonly answered: number;
  /** the newest of those failed reads, at most UNAVAILABLE_AFTER: a late answer keeps the ones newer than it */
  readonly failed: readonly number[];
}

export type HealthBook<T> = ReadonlyMap<string, MachineHealth<T>>;

/** failed reads in a row after which the header says unavailable rather than unknown */
export const UNAVAILABLE_AFTER = 2;

const NOTHING_YET: MachineHealth<never> = { confirmed: null, failures: 0, answered: 0, failed: [] };

export function machineHealth<T>(book: HealthBook<T>, machineId: string): MachineHealth<T> {
  return book.get(machineId) ?? NOTHING_YET;
}

/** Takes in one completed read of one PC; `read` is the number the read got as it started. */
export function applyHealthRead<T>(book: HealthBook<T>, machineId: string, read: number, answer: HealthAnswer<T>): HealthBook<T> {
  const current = machineHealth(book, machineId);
  // a newer answer is already in
  if (read <= current.answered) return book;
  // an answer that lands after newer reads failed brings its capabilities, and those failures still stand;
  // only the newest failures are kept, as no more than UNAVAILABLE_AFTER of them change what the header says
  const failed = answer.ok
    ? current.failed.filter((failure) => failure > read)
    : [...current.failed, read].sort((a, b) => a - b).slice(-UNAVAILABLE_AFTER);
  const next = new Map(book);
  next.set(machineId, answer.ok
    ? { confirmed: answer.value, failures: failed.length, answered: read, failed }
    : { confirmed: current.confirmed, failures: failed.length, answered: current.answered, failed });
  return next;
}

export function healthFreshness(health: Pick<MachineHealth<unknown>, "confirmed" | "failures">): HealthFreshness {
  if (health.failures === 0) return health.confirmed === null ? "pending" : "fresh";
  return health.failures < UNAVAILABLE_AFTER ? "unknown" : "unavailable";
}
