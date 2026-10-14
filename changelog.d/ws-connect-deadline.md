### Fixed
- A connection attempt that hangs (a phone waking on a dead network) is given up after 8 seconds
  and tried again with a longer wait each time (up to 30 seconds), so a slow but working link
  such as a remote PC still connects, instead of leaving the app disconnected until reload.
- A page coming back to the screen, or a network coming back, with a dead connection reconnects
  at once, even when the browser had not yet reported the connection closed or a retry was
  still waiting out a long deadline.
