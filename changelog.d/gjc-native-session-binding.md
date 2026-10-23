### Changed
- GJC chat and GJC done alerts read the active session reported by a native extension instead of
  querying the SDK broker. Anyone upgrading must install it with
  `bun scripts/install-gjc-integration.ts` and restart GJC: without it, chat uses Terminal and the
  pane keeps herdr's own status, which may miss a done alert. Command menus use the filesystem
  skill catalog.
