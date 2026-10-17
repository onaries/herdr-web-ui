### Fixed
- Dialogs take keyboard focus before their first paint, falling back when the preferred control
  is unavailable, so an immediate Escape closes the dialog instead of reaching the terminal.
  New workspace and New tab reset failed agent launches before reopening their fields.
