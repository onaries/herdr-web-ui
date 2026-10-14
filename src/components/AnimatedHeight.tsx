import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";

import "./AnimatedHeight.css";

import { heightFor, RESTING, SETTLE_GRACE_MS, settled, transitionSpan, type HeightState } from "../lib/animatedHeight.ts";
import { contentHeightFor } from "../lib/workFoldHeight.ts";

/**
 * A box that follows its content's height through a transition (AnimatedHeight.css), so what
 * opens, folds or grows inside it moves the page smoothly instead of jumping it. The content is
 * measured before paint and watched for size changes after; while the box moves it clips what
 * it holds. `open={false}` folds the box to nothing: the content stays drawn while the box
 * slides shut and leaves the tree once it has, so a folded block costs nothing. `holdHeight`
 * keeps the last height while a replacement loads, the replacement sized to it.
 * Adapted from t3code's AnimatedHeight (MIT).
 */
export function AnimatedHeight({ children, open = true, holdHeight = false, animateContent = true }: { children: ReactNode; open?: boolean; holdHeight?: boolean; animateContent?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<HeightState>(() => (open ? RESTING : heightFor(RESTING, null)));
  // a fold keeps its content until the box has slid shut; folded, nothing is drawn or measured
  const drawn = open || state.moving || state.height !== 0;

  useLayoutEffect(() => {
    if (!open) { setState((current) => heightFor(current, null)); return; }
    if (holdHeight) return;
    const element = content.current;
    if (element === null) return;
    const measure = (): void => setState((current) => contentHeightFor(current, element.getBoundingClientRect().height, animateContent));
    // before paint: a box opened from nothing starts its move there, not from auto
    setState((current) => heightFor(current, element.getBoundingClientRect().height));
    // a size change is reported after layout and before paint: the box moves in that same frame,
    // or the paint would show the content at its new size for a frame before the move begins
    const observer = new ResizeObserver(() => flushSync(measure));
    observer.observe(element);
    return () => observer.disconnect();
  }, [open, holdHeight, animateContent]);

  // the transition reports the end of the move; one that never runs (reduced motion, Panel
  // motion off) or never reports is given its own span, then the box rests
  useEffect(() => {
    if (!state.moving) return;
    const element = box.current;
    const style = element === null ? null : getComputedStyle(element);
    const span = style === null ? 0 : transitionSpan(style.transitionDuration, style.transitionDelay);
    if (span === 0) { setState(settled); return; }
    const timer = window.setTimeout(() => setState(settled), span + SETTLE_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  return <div ref={box} className={`animated-height${state.moving ? " is-moving" : animateContent ? "" : " is-static"}`} style={state.height === null ? undefined : { height: state.height }}
    onTransitionEnd={(event) => { if (event.target === event.currentTarget && event.propertyName === "height") setState(settled); }}>
    <div ref={content} className="animated-height-content" style={holdHeight ? { height: "100%" } : undefined}>{drawn ? children : null}</div>
  </div>;
}
