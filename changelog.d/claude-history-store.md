### Fixed
- Earlier Claude sessions are listed from the store of the pane you open the list from
  (`CLAUDE_CONFIG_DIR`), and Resume starts the session in that same store, so a second account's
  session with the same id is neither listed nor opened by mistake. On Windows the pane's Claude is
  found under its shell. If the new tab's shell picks another store (a startup file that exports
  `CLAUDE_CONFIG_DIR`), the tab is closed and the list says so. When the store cannot be told, or
  a new tab would not start in the same store, Resume is shown as unavailable instead of starting
  the session in the default store. A remote PC shows Resume as unavailable until its bridge is
  updated.
