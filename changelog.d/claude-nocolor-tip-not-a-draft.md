### Fixed
- Chat sends to Claude Code started with `NO_COLOR` are no longer refused because its empty-prompt
  tip (`Try "…"`) was read as text typed in the terminal, and "Clear it and send" no longer fails
  on it.
