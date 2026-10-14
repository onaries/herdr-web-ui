/**
 * Placeholder rows for a list on its way (components/Skeleton.tsx draws one): a pill the length
 * of a name, in three lengths and a fixed order, so two reads draw the same rows and nothing
 * shuffles between them. One row per row the last listing had, so a refresh holds the list's
 * height; a few before anything has been listed.
 */
export type SkeletonWidth = "short" | "medium" | "long";

// no two neighbours alike, around the wrap too
const WIDTHS: readonly SkeletonWidth[] = ["medium", "long", "short", "medium", "short", "long"];

/** the rows drawn before the first listing */
export const FIRST_SKELETON_ROWS = 3;
/** the rows the Changes list shows before it scrolls (RepoChanges.css): a longer list is cut there too */
export const MAX_SKELETON_ROWS = 14;

export function skeletonRows(listed: number | null): SkeletonWidth[] {
  const count = listed === null ? FIRST_SKELETON_ROWS : Math.min(Math.max(listed, 1), MAX_SKELETON_ROWS);
  return Array.from({ length: count }, (_, index) => WIDTHS[index % WIDTHS.length]!);
}
