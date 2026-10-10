/** Serializes explicit viewport intents without queuing gestures. A newer Find cancels unsent
 * drag offsets, waits for scroll requests already sent, and keeps later drags out until it ends.
 * The pane owns this gate, so a tools effect restart cannot forget an outstanding native write. */
export class ViewportIntentGate {
  private writes = new Set<Promise<unknown>>();
  private search: object | null = null;
  private cancelPendingScroll: (() => void) | null = null;
  private listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly isSearching = (): boolean => this.search !== null;
  private publish(): void { for (const listener of this.listeners) listener(); }

  registerScrollCancellation(cancel: () => void): () => void {
    this.cancelPendingScroll = cancel;
    return () => { if (this.cancelPendingScroll === cancel) this.cancelPendingScroll = null; };
  }

  /** A refused gesture is dropped, never resumed after Find or a reconnect. */
  scroll<T>(send: () => Promise<T>): Promise<T> | null {
    if (this.search !== null || this.writes.size > 0) return null;
    const request = send();
    this.writes.add(request);
    void request.then(() => this.writes.delete(request), () => this.writes.delete(request));
    return request;
  }

  async beginSearch(): Promise<(() => void) | null> {
    if (this.search !== null) return null;
    const owner = {};
    this.search = owner;
    // Set the gate before invoking either UI callback: no gesture can slip between them.
    this.cancelPendingScroll?.();
    this.publish();
    await Promise.allSettled([...this.writes]);
    // The caller checks that its FindBar still belongs to a mounted, ready pane before sending.
    // Closing the bar does not release an already-sent Find; its finally releases this claim.
    return () => {
      if (this.search !== owner) return;
      this.search = null;
      this.publish();
    };
  }
}
