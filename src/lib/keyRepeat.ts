import type { KeyBarItem } from "./keyBar.ts";

export const KEY_REPEAT_DELAY_MS = 400;
export const KEY_REPEAT_INTERVAL_MS = 50;
export const KEY_REPEAT_MOVE_SLOP_PX = 10;

export function isRepeatableKeyBarItem(item: KeyBarItem): boolean {
  return item.type === "key" && (item.key === "ArrowUp" || item.key === "ArrowDown"
    || item.key === "ArrowLeft" || item.key === "ArrowRight");
}

export interface KeyRepeatClock {
  setTimeout: (callback: () => void, delay: number) => unknown;
  clearTimeout: (timer: unknown) => void;
}

export interface KeyRepeat {
  press: (x: number, y: number) => void;
  /** Returns true only when movement cancels a hold that has not started repeating. */
  move: (x: number, y: number) => boolean;
  release: () => void;
  cancel: () => void;
  /** Consumes the one click suppressed by a released, repeating hold. */
  takeClick: () => boolean;
}

const defaultClock: KeyRepeatClock = {
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (timer) => globalThis.clearTimeout(timer as number),
};

/** A hold sends only from timers; a tap stays on the caller's ordinary click path. */
export function createKeyRepeat(send: () => void, clock: KeyRepeatClock = defaultClock): KeyRepeat {
  let timer: unknown = null;
  let generation = 0;
  let active = false;
  let repeating = false;
  let suppressClick = false;
  let startX = 0;
  let startY = 0;

  const stop = (): void => {
    generation++;
    active = false;
    repeating = false;
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };

  return {
    press(x, y) {
      stop();
      suppressClick = false;
      active = true;
      startX = x;
      startY = y;
      const pressedGeneration = generation;
      const repeat = (): void => {
        if (!active || generation !== pressedGeneration) return;
        timer = null;
        repeating = true;
        send();
        // Sending may synchronously release/cancel this hold or start a new one.
        if (active && generation === pressedGeneration) timer = clock.setTimeout(repeat, KEY_REPEAT_INTERVAL_MS);
      };
      timer = clock.setTimeout(repeat, KEY_REPEAT_DELAY_MS);
    },
    move(x, y) {
      if (!active || repeating) return false;
      const dx = x - startX;
      const dy = y - startY;
      if (dx * dx + dy * dy <= KEY_REPEAT_MOVE_SLOP_PX * KEY_REPEAT_MOVE_SLOP_PX) return false;
      stop();
      return true;
    },
    release() {
      if (repeating) suppressClick = true;
      stop();
    },
    cancel() {
      stop();
      suppressClick = false;
    },
    takeClick() {
      const allowed = !suppressClick;
      suppressClick = false;
      return allowed;
    },
  };
}
