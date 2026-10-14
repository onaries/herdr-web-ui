### Fixed
- A phone put away while its pane stayed attached (a queued message, a mirrored pane) no longer
  comes back to a dead "Terminal output stopped" notice: when the page is in use again, the pane
  attaches again by itself, once. A stop while the page stays in use still waits for you, and the
  notice's Reconnect button now attaches again in place instead of reloading the page.
