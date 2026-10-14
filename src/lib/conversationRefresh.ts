/** With pushes, a lost one still gets a full conversation read. */
const BACKSTOP_MS = 10_000;

/** Pushes never start newest-page reads faster than the former 2s polling cadence, and a chat
 * without them (an older bridge, a tab that let go of its pane) reads at that cadence. */
const INVALIDATION_MS = 2000;

/** One serial lane for newest pages and their gap fills; an older page starts in it, after the
 * newest read before it, but never holds the next newest read back. */
export class ConversationRefresh {
  private read: (() => Promise<void>) | null = null;
  private pending = false;
  private invalidated = false;
  private running = false;
  private timer: number | undefined;
  private newestAt = -Infinity;
  private pushes = false;
  private readonly pages: (() => Promise<void>)[] = [];

  /** Replace a cancelled reader without letting its still-pending REST request overlap this one. */
  setRead(read: () => Promise<void>): void {
    this.clearTimer();
    this.pending = false;
    this.invalidated = false;
    this.newestAt = -Infinity;
    this.read = read;
  }

  /** Whether the bridge pushes this pane's transcript changes; without, the backstop is the poll. */
  setPushes(available: boolean): void {
    if (this.pushes === available) return;
    this.pushes = available;
    // a waiting backstop takes the new cadence; a read in flight schedules it when it ends
    if (this.read !== null && !this.running && !this.invalidated && this.timer !== undefined) {
      this.clearTimer();
      this.timer = window.setTimeout(() => this.refresh(), this.backstop());
    }
  }

  refresh(): void {
    if (this.read === null) return;
    this.clearTimer();
    this.pending = true;
    this.invalidated = false;
    void this.drain();
  }

  /** The first push after idle reads immediately; further pushes share a fixed trailing deadline. */
  invalidate(): void {
    if (this.read === null || this.invalidated) return;
    this.invalidated = true;
    this.clearTimer();
    void this.drain();
  }

  /** An explicitly requested older page starts once the newest read in flight (and its gap fill)
   * has settled, so a history change found there drops it first. A slow older page never delays
   * the newest page: a clear or a new turn still shows while it loads, and its caller discards it. */
  page<T>(read: () => Promise<T>): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    this.pages.push(async () => {
      try { resolve(await read()); }
      catch (cause) { reject(cause); }
    });
    this.clearTimer();
    void this.drain();
    return promise;
  }

  /** Hidden/unmounted readers leave no timer or pending refresh; an in-flight read finishes first. */
  stop(): void {
    this.read = null;
    this.pending = false;
    this.invalidated = false;
    this.clearTimer();
  }

  private backstop(): number {
    return this.pushes ? BACKSTOP_MS : INVALIDATION_MS;
  }

  private clearTimer(): void {
    window.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (true) {
        const page = this.pages.shift();
        if (page !== undefined) {
          void page();
          continue;
        }
        if (this.read === null || (!this.pending && !this.invalidated)) break;
        if (!this.pending && performance.now() < this.newestAt + INVALIDATION_MS) break;
        this.pending = false;
        this.invalidated = false;
        // Monotonic elapsed time keeps wall-clock corrections out of the rate bound.
        this.newestAt = performance.now();
        await this.read();
      }
    } finally {
      this.running = false;
      if (this.read !== null) {
        this.timer = this.invalidated
          ? window.setTimeout(() => {
            this.timer = undefined;
            void this.drain();
          }, Math.max(0, this.newestAt + INVALIDATION_MS - performance.now()))
          : window.setTimeout(() => this.refresh(), this.backstop());
      }
    }
  }
}
