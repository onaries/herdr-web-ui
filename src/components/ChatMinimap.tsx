import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";

import { minimapCurrent, minimapFits, minimapStep, minimapTop, MINIMAP_MIN_TURNS, type MinimapTurn } from "../lib/chatMinimap.ts";
import { useT } from "../lib/i18n.ts";
import "./ChatMinimap.css";

export interface ChatMinimapProps {
  turns: readonly MinimapTurn[];
  /** the timeline's row keys in order, to tell which rows are on screen */
  rowKeys: readonly string[];
  scroller: RefObject<HTMLDivElement | null>;
  onJump: (row: number) => void;
}

const SPACING_PX = 8;

/** A tick per turn the user sent, beside the chat column; the turn in view is marked. */
export function ChatMinimap({ turns, rowKeys, scroller, onJump }: ChatMinimapProps) {
  const t = useT();
  const [current, setCurrent] = useState<number | null>(null);
  const [fits, setFits] = useState(false);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const ticks = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    const node = scroller.current;
    if (node === null) return;
    const positions = new Map(rowKeys.map((key, index) => [key, index]));
    const turnRows = turns.map((turn) => turn.row);
    let frame = 0;
    const measure = (): void => {
      frame = 0;
      const view = node.getBoundingClientRect();
      let first = Infinity, last = -1;
      for (const row of node.querySelectorAll<HTMLElement>("[data-chat-row]")) {
        const box = row.getBoundingClientRect();
        const index = positions.get(row.dataset.chatRow ?? "");
        if (index === undefined || box.bottom <= view.top || box.top >= view.bottom) continue;
        first = Math.min(first, index); last = Math.max(last, index);
      }
      const next = last < 0 ? null : minimapCurrent(turnRows, first, last);
      setCurrent((previous) => previous === next ? previous : next);
      const column = node.querySelector<HTMLElement>(".chat-transcript");
      const nextFits = column !== null && minimapFits(view.width, column.getBoundingClientRect().width);
      setFits((previous) => previous === nextFits ? previous : nextFits);
    };
    const schedule = (): void => { if (frame === 0) frame = requestAnimationFrame(measure); };
    schedule();
    node.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(node);
    return () => {
      cancelAnimationFrame(frame);
      node.removeEventListener("scroll", schedule);
      observer.disconnect();
    };
  }, [scroller, rowKeys, turns]);

  if (turns.length < MINIMAP_MIN_TURNS || !fits) return null;
  const stop = Math.min(focusIndex ?? current ?? turns.length - 1, turns.length - 1);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const next = minimapStep(stop, turns.length, event.key);
    if (next === null) return;
    event.preventDefault();
    setFocusIndex(next);
    ticks.current[next]?.focus();
  };
  return <nav
    className="chat-minimap"
    aria-label={t("Conversation turns")}
    style={{ height: `min(${(turns.length - 1) * SPACING_PX}px, calc(100% - 12rem))`, "--minimap-steps": turns.length - 1 } as CSSProperties}
    onKeyDown={onKeyDown}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocusIndex(null); }}
    onWheel={(event) => scroller.current?.scrollBy({ top: event.deltaY })}
  >
    {turns.map((turn, index) => <button
      key={turn.row}
      ref={(element) => { ticks.current[index] = element; }}
      type="button"
      className="chat-minimap-tick"
      style={{ top: `${minimapTop(index, turns.length)}%` }}
      tabIndex={index === stop ? 0 : -1}
      aria-label={t("Go to turn {n}", { n: index + 1 })}
      aria-current={index === current ? "true" : undefined}
      title={turn.preview || undefined}
      onFocus={() => setFocusIndex(index)}
      onClick={() => onJump(turn.row)}
    />)}
  </nav>;
}
