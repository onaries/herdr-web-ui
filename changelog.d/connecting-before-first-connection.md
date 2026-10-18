### Fixed
- The header's connection chip, the chat's footer, the terminal's banner and the composer's offline
  sentence say "Connecting" until this page has connected to the PC once, and "Reconnecting" only after
  a connection dropped; before, every wait read as a reconnect, a fresh page's first one included.
- The pre-connect shell's "Connecting…" line is translated like every other status line.
