import { useCallback, useLayoutEffect, useRef, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { Keyboard } from "lucide-react";

import "./KeyBar.css";

import type { KeyBarExtra, KeyBarKey, StickyModifiers } from "../lib/keys.ts";
import { keyBarItemId, keyBarItemLabel, type KeyBarItem, type KeyBarKeyItem } from "../lib/keyBar.ts";
import { createKeyRepeat, isRepeatableKeyBarItem, type KeyRepeat } from "../lib/keyRepeat.ts";
import { useT } from "../lib/i18n.ts";

export type { KeyBarKey };

export interface KeyBarProps {
  disabled?: boolean;
  /** Changing the terminal target or lens cancels any held arrow. */
  holdScope?: string;
  /** Modifier buttons toggle; other keys go to the terminal. */
  onKey: (item: KeyBarKeyItem) => void;
  modifiers: StickyModifiers;
  onToggleModifier: (modifier: keyof StickyModifiers) => void;
  items: readonly KeyBarItem[];
  /** on a touch screen: whether the keyboard types straight into the terminal (else the input line) */
  directTyping?: boolean;
  onToggleDirect?: () => void;
}

/**
 * Cancelling pointerdown AND mousedown keeps focus, and with it the soft
 * keyboard, on xterm's textarea; the click still fires.
 */
function keepFocus(event: PointerEvent<HTMLButtonElement> | MouseEvent<HTMLButtonElement>): void {
  event.preventDefault();
}

interface KeyProps {
  disabled?: boolean;
  dataKey: string;
  label?: string;
  pressed?: boolean;
  onPress: () => void;
  repeatable?: boolean;
  holdScope?: string;
  children: ReactNode;
}

function Key({ dataKey, label, pressed, onPress, children, disabled, repeatable, holdScope }: KeyProps) {
  const onPressRef = useRef(onPress);
  onPressRef.current = onPress;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const pointerRef = useRef({ id: null as number | null, pendingClick: false, cancelClick: false });
  const repeatRef = useRef<KeyRepeat | null>(null);
  if (repeatable && repeatRef.current === null) {
    repeatRef.current = createKeyRepeat(() => {
      if (!disabledRef.current) onPressRef.current();
    });
  }

  const cancelHold = useCallback(() => {
    const pointer = pointerRef.current;
    if (pointer.pendingClick) pointer.cancelClick = true;
    pointer.id = null;
    repeatRef.current?.cancel();
  }, []);

  useLayoutEffect(() => {
    if (!repeatable || disabled) {
      cancelHold();
      return;
    }
    const onVisibilityChange = (): void => {
      if (document.hidden) cancelHold();
    };
    window.addEventListener("blur", cancelHold);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelHold();
      window.removeEventListener("blur", cancelHold);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [cancelHold, disabled, holdScope, repeatable]);

  const cancelPointer = (event: PointerEvent<HTMLButtonElement>): void => {
    if (pointerRef.current.id === event.pointerId) cancelHold();
  };
  return (
    <button
      type="button"
      disabled={disabled}
      className={`key${pressed ? " is-armed" : ""}`}
      data-key={dataKey}
      aria-label={label}
      aria-pressed={pressed}
      tabIndex={-1}
      onPointerDown={(event) => {
        keepFocus(event);
        if (!repeatable || disabled || event.button !== 0 || !event.isPrimary || pointerRef.current.id !== null) return;
        const pointer = pointerRef.current;
        pointer.id = event.pointerId;
        pointer.pendingClick = true;
        pointer.cancelClick = false;
        repeatRef.current?.press(event.clientX, event.clientY);
        // Capture keeps release/move visible outside the key; browser panning can still cancel it.
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
      }}
      onPointerMove={repeatable ? (event) => {
        if (pointerRef.current.id !== event.pointerId) return;
        if (repeatRef.current?.move(event.clientX, event.clientY)) pointerRef.current.cancelClick = true;
      } : undefined}
      onPointerUp={repeatable ? (event) => {
        if (pointerRef.current.id !== event.pointerId) return;
        repeatRef.current?.release();
        // Ignore the lost capture that follows release, preserving the click gate.
        pointerRef.current.id = null;
      } : undefined}
      onPointerCancel={repeatable ? cancelPointer : undefined}
      onLostPointerCapture={repeatable ? cancelPointer : undefined}
      onMouseDown={keepFocus}
      onContextMenu={keepFocus}
      onClick={() => {
        if (!repeatable) {
          onPress();
          return;
        }
        const pointer = pointerRef.current;
        const allowed = repeatRef.current?.takeClick() ?? true;
        const cancelled = pointer.cancelClick;
        pointer.pendingClick = false;
        pointer.cancelClick = false;
        if (allowed && !cancelled && !disabled) onPress();
      }}
    >
      {children}
    </button>
  );
}

type Direction = "up" | "down" | "left" | "right";

const CHEVRON: Record<Direction, string> = {
  up: "M5 12.5l5-5 5 5",
  down: "M5 7.5l5 5 5-5",
  left: "M12.5 5l-5 5 5 5",
  right: "M7.5 5l5 5-5 5",
};

function Chevron({ direction }: { direction: Direction }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={CHEVRON[direction]} />
    </svg>
  );
}

export const ARROWS: ReadonlyArray<{ key: KeyBarKey; label: string; direction: Direction }> = [
  { key: "ArrowUp", label: "Up", direction: "up" },
  { key: "ArrowDown", label: "Down", direction: "down" },
  { key: "ArrowLeft", label: "Left", direction: "left" },
  { key: "ArrowRight", label: "Right", direction: "right" },
];

/** Legacy single-key aliases: their caps and spoken names where a cap does not read as one. */
export const EXTRA_KEY_CAPS: Partial<Record<KeyBarExtra, { cap: string; label?: string }>> = {
  "ctrl-d": { cap: "^D", label: "Control D" },
  "ctrl-z": { cap: "^Z", label: "Control Z" },
  pipe: { cap: "|" },
  tilde: { cap: "~" },
  slash: { cap: "/" },
};

/**
 * Touch key bar under the terminal. Keys are tabIndex -1 on purpose: they exist
 * for touch, a hardware keyboard already has all of them. Hence role="group", not
 * toolbar: a toolbar promises arrow-key navigation between items, which these skip.
 */
export function KeyBar({ onKey, modifiers, onToggleModifier, items, directTyping, onToggleDirect, disabled, holdScope }: KeyBarProps) {
  const t = useT();
  return (
    <div className="key-bar" role="group" aria-label={t("Terminal keys")}>
      {/* first: on a narrow cover screen the row scrolls, and the mode toggle must not be the key cut off */}
      {onToggleDirect && (
        <Key disabled={disabled} dataKey="direct" label={t("Type straight into the terminal")} pressed={directTyping} onPress={onToggleDirect}>
          <Keyboard aria-hidden="true" />
        </Key>
      )}
      {items.map((item) => {
        if (item.type === "modifier") {
          const cap = { ctrl: "Ctrl", alt: "Alt", shift: "Shift" }[item.modifier];
          const dataKey = { ctrl: "Control", alt: "Alt", shift: "Shift" }[item.modifier];
          return <Key key={keyBarItemId(item)} disabled={disabled} dataKey={dataKey} pressed={modifiers[item.modifier]} onPress={() => onToggleModifier(item.modifier)}>{cap}</Key>;
        }
        const arrow = ARROWS.find((candidate) => candidate.key === item.key);
        const extra = EXTRA_KEY_CAPS[item.key as KeyBarExtra];
        const label = item.modifiers !== undefined ? t("Press {key}", { key: keyBarItemLabel(item) })
          : arrow ? t(arrow.label)
          : item.key === "ctrl-c" ? t("Control C")
          : item.key === "BackTab" ? t("Shift Tab")
          : item.key === "PageUp" ? t("Page up")
          : item.key === "PageDown" ? t("Page down")
          : extra?.label ? t(extra.label) : undefined;
        return <Key key={keyBarItemId(item)} disabled={disabled} dataKey={item.modifiers === undefined ? item.key : keyBarItemId(item)} label={label} onPress={() => onKey(item)}
          repeatable={isRepeatableKeyBarItem(item)} holdScope={holdScope}>
          {arrow && item.modifiers === undefined ? <Chevron direction={arrow.direction} /> : keyBarItemLabel(item)}
        </Key>;
      })}
    </div>
  );
}
