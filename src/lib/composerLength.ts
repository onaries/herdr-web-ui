/**
 * Why the composer stopped taking text. The box's maxLength clamps typing and pasting without a word;
 * these say it: the box is full, and how much of a paste did not fit. Pure, DOM-free.
 */

/** The box holds as many characters as its cap: nothing typed or pasted is added any more. */
export function composerFull(length: number, max: number): boolean {
  return length >= max;
}

/** Characters of `pasted` that do not fit when it replaces `current[start, end)` under `max`; 0 when all of it fits. */
export function pasteOverflow(current: string, start: number, end: number, pasted: string, max: number): number {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const room = Math.max(0, max - (current.length - (hi - lo)));
  return Math.max(0, pasted.length - room);
}

/** A count with the reader's own digit grouping: 20 000 or 20,000. */
export function formatChars(count: number): string {
  return new Intl.NumberFormat().format(count);
}
