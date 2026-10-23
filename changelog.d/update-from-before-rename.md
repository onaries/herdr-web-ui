### Fixed
- Updating in the app from 0.4.13 starts the new release's own supervisor instead of falling back to
  0.4.13's with an "updated supervisor failed to start" notice: while the launcher from before the
  rename runs, the state stays in `~/.config/herdr-web-ui`, where that launcher finds the installed
  release, and moves to `~/.config/ovis` once the app starts from an updated checkout or plugin.
