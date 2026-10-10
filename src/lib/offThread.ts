/** The part of a `Worker` the queue uses, so a test can stand in for one. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
}

/** A request sent to a worker, and what it answers. */
export interface OffThreadRequest<Q> { id: number; request: Q }
export interface OffThreadAnswer<R> { id: number; result: R | null }

/** A job queued for a worker. Its promise never rejects: a job that fails, runs over or is cancelled gives `null`. */
export interface OffThreadJob<R> {
  promise: Promise<R | null>;
  /**
   * Drops the job if it has not started, and says whether it did: its promise then gives `null`,
   * which says nothing about the request. One already running finishes, and its answer is still delivered.
   */
  cancel(): boolean;
}

interface Entry<Q, R> {
  id: number;
  request: Q;
  transfer: Transferable[];
  resolve: (result: R | null) => void;
}

/**
 * Work that may take long, done one job at a time in a worker so the page never waits for it. A
 * job gets `budgetMs` from its start: past it the worker is ended (a tokenizer stuck in a quadratic
 * input cannot be interrupted any other way), the job gives `null`, and the next job starts a new
 * worker. The worker is started on the first job, not before.
 */
export function createOffThreadQueue<Q, R>(spawn: () => WorkerLike, budgetMs: number): (request: Q, transfer?: Transferable[]) => OffThreadJob<R> {
  let worker: WorkerLike | null = null;
  let running: (Entry<Q, R> & { timer: ReturnType<typeof setTimeout> }) | null = null;
  const waiting: Entry<Q, R>[] = [];
  let nextId = 1;

  /** Ends the running job with `result`; `stop` also ends its worker, which is then replaced. */
  const finish = (result: R | null, stop: boolean): void => {
    if (running === null) return;
    clearTimeout(running.timer);
    const { resolve } = running;
    running = null;
    if (stop && worker !== null) {
      worker.terminate();
      worker = null;
    }
    resolve(result);
    pump();
  };

  /** Starts the next waiting job, if none runs. */
  const pump = (): void => {
    if (running !== null) return;
    const next = waiting.shift();
    if (next === undefined) return;
    if (worker === null) {
      try {
        worker = spawn();
      } catch {
        next.resolve(null);
        pump();
        return;
      }
      worker.onmessage = (event: MessageEvent) => {
        const answer = event.data as OffThreadAnswer<R>;
        if (running !== null && answer.id === running.id) finish(answer.result, false);
      };
      worker.onerror = () => finish(null, true);
    }
    running = { ...next, timer: setTimeout(() => finish(null, true), budgetMs) };
    worker.postMessage({ id: next.id, request: next.request } satisfies OffThreadRequest<Q>, next.transfer);
  };

  return (request, transfer = []) => {
    let entry!: Entry<Q, R>;
    const promise = new Promise<R | null>((resolve) => {
      entry = { id: nextId++, request, transfer, resolve };
    });
    waiting.push(entry);
    pump();
    return {
      promise,
      cancel: () => {
        const index = waiting.indexOf(entry);
        if (index < 0) return false;
        waiting.splice(index, 1);
        entry.resolve(null);
        return true;
      },
    };
  };
}

/**
 * The worker's side: answers each request with `handle`'s result, and with `null` when it throws
 * (a stack overflow in a parser included). `handle` may name buffers to hand over without a copy.
 */
export function serveOffThread<Q, R>(handle: (request: Q) => { result: R; transfer?: Transferable[] }): void {
  const scope = globalThis as unknown as { onmessage: ((event: MessageEvent) => void) | null; postMessage: (message: unknown, transfer?: Transferable[]) => void };
  scope.onmessage = (event: MessageEvent) => {
    const { id, request } = event.data as OffThreadRequest<Q>;
    let answer: { result: R | null; transfer?: Transferable[] };
    try {
      answer = handle(request);
    } catch {
      answer = { result: null };
    }
    scope.postMessage({ id, result: answer.result } satisfies OffThreadAnswer<R>, answer.transfer ?? []);
  };
}
