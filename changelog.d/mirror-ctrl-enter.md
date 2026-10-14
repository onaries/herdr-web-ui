### Fixed
- Ctrl+Enter in a mirrored terminal (Windows, or a PC without Node for the terminal sidecar)
  reaches Claude Code as its "send now" again instead of a plain Enter, and `bun run test:ui`
  checks it there instead of stopping at that check.
