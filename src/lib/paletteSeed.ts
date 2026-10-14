/**
 * The text the command palette opens with. A caller that opens it from elsewhere (a button, an
 * empty state) passes a query: `>` keeps the actions alone, a word filters the panes. Anything
 * else (no argument, or the click event of a handler passed as `onClick={actions.openPalette}`)
 * opens it blank, and the query is never trimmed: a trailing space is the user's to keep.
 */
export function paletteOpenQuery(query: unknown): string {
  return typeof query === "string" ? query : "";
}
