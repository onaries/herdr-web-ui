### Changed
- Settings variables are now `OVIS_*` (`OVIS_TOKEN`, `OVIS_STATE_DIR`, ...; `OVIS_REF` for the
  installer's ref). The old `HERDR_WEB_*` names still work, and the `OVIS_*` one wins where both
  are set.
- The state dir moves from `~/.config/herdr-web-ui` to `~/.config/ovis` the first time the app
  starts, leaving a link at the old path; sign-in cookies, browser storage, the offline cache and
  pasted files (`<pane cwd>/.ovis`) use the Ovis name too. Browsers signed in before keep their
  sign-in, paired devices stay paired, and settings and drafts carry over.
