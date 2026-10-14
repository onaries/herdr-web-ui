### Fixed
- A chat message queued for the next turn is no longer delivered after the tab has gone to another
  address: a page the browser kept for Back still held its connection, so the message went out
  while the page shown said it was not confirmed. Leaving a page now ends its connection.
