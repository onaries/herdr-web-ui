import "./Skeleton.css";

import type { SkeletonWidth } from "../lib/skeleton.ts";

/**
 * A placeholder the size of what is loading in its place, so the layout holds until it lands: a
 * pill in the hover tone that dims and brightens in steps. It says nothing to assistive tech; the
 * surface that draws it names the wait in a status of its own.
 */
export function Skeleton({ className, width }: { className?: string; width?: SkeletonWidth }) {
  return <span className={className === undefined ? "skeleton" : `skeleton ${className}`} data-width={width} aria-hidden="true" />;
}
