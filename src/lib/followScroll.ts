/**
 * Whether a follow-the-end scroll glides. Streamed output lands a paragraph at a time; while a
 * turn works, each landing glides to the end instead of snapping. A reader who prefers reduced
 * motion, a settled conversation, and a layout the reader changed by hand (a block opened) all
 * keep the instant scroll so nothing visibly travels.
 */
export function followGlides(input: { working: boolean; reducedMotion: boolean; manualLayout?: boolean }): boolean {
  return input.working && !input.reducedMotion && input.manualLayout !== true;
}
