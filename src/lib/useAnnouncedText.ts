import { useEffect, useState } from "react";

/**
 * The words of a live status line, from the frame after its box mounts: a `role="status"` element
 * that appears together with its words is not announced, one that is in the document and then gets
 * them is. The caller renders the box on every render (clipped while empty, `.visually-hidden`,
 * never `display: none`) and gives it what this returns: nothing on the render that mounts it,
 * `text` from the next animation frame on, at once for every later change.
 */
export function useAnnouncedText(text: string | null): string | null {
  const [framed, setFramed] = useState(false);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setFramed(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);
  return framed ? text : null;
}
