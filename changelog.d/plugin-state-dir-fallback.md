### Fixed
- `status` and `stop` run by hand (without herdr's environment) now find the server herdr started,
  in the plugin state dir herdr keeps (also on Windows), instead of reporting it down because an
  old checkout's stale pid file was looked at first. By @vibewriter-hand.
