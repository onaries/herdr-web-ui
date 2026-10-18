### Changed
- The plan meters show what is left of each plan's 5-hour session by default (a choice already
  saved is kept), fill the sidebar footer's row instead of stopping at four, and their tooltip
  names a limit near its end that a chip does not show.
- Settings in the sidebar footer is its gear alone; its name stays in the tooltip and for screen
  readers.
- The Pinned caption sits on the pinned card's top edge instead of above it.
- A workspace row finds its project's icon in more places (`static/`, Next.js `app/icon.*`,
  Electron `build/icon.png`, `logo.svg`, `assets/logo.png` and others), all asked at once. On a
  repository row with worktrees, the folder opens and closes with the group, and a project icon
  turns into that folder under the pointer.
