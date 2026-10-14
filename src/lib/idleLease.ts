/**
 * One shared resource for every holder: made with the first `get`, kept while anyone holds it,
 * and disposed only after it has gone `idleMs` without a holder, so a holder that leaves and comes
 * back (a viewer closed and reopened, a remount) takes the same one. A `get` nobody follows with a
 * `hold` (a render React threw away) arms the same idle disposal, so it cannot leak. The diff
 * worker pool (components/DiffWorkerPool.tsx) is the user: its workers and their highlight caches
 * outlive a closed viewer instead of starting cold on the next.
 */

export interface IdleLeaseTimers {
  set: (run: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

export interface IdleLease<T> {
  /** The resource, made if there is none; safe to call while rendering. */
  get: () => T;
  /** Keeps the resource from idling out until the returned release (once per hold). */
  hold: () => () => void;
  /** The live resource without making one: undefined before the first get and after a disposal. */
  current: () => T | undefined;
}

const DEFAULT_TIMERS: IdleLeaseTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Entry<T> { value: T; holders: number; idle: unknown }

export function createIdleLease<T>(
  create: () => T,
  dispose: (value: T) => void,
  idleMs: number,
  timers: IdleLeaseTimers = DEFAULT_TIMERS,
): IdleLease<T> {
  let entry: Entry<T> | undefined;

  const armIdle = (held: Entry<T>): void => {
    if (held.idle !== undefined) timers.clear(held.idle);
    held.idle = timers.set(() => {
      held.idle = undefined;
      if (held.holders > 0) return;
      if (entry === held) entry = undefined;
      dispose(held.value);
    }, idleMs);
  };

  const ensure = (): Entry<T> => {
    if (entry !== undefined) return entry;
    const made: Entry<T> = { value: create(), holders: 0, idle: undefined };
    entry = made;
    armIdle(made);
    return made;
  };

  return {
    get: () => ensure().value,
    hold() {
      const held = ensure();
      if (held.idle !== undefined) { timers.clear(held.idle); held.idle = undefined; }
      held.holders += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        held.holders -= 1;
        if (held.holders === 0) armIdle(held);
      };
    },
    current: () => entry?.value,
  };
}
