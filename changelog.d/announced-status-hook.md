### Fixed
- Screen readers now hear every status line the app can open with: "Connecting…", the header's
  connection word, a PC's state word, "Loading workspaces…" and "Waiting for terminal input…" are in
  the page before their words arrive, as "Sending your answer…" and the loading lines already were.

### Maintenance
- One `useAnnouncedText` hook (`src/lib/`) carries the announced-status pattern that the header note,
  the file viewer and the two sidebars each copied; DESIGN.md names the pattern and where the prompt
  card's `aria-busy` lives.
