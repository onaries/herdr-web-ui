### Fixed
- Tapping an alert no longer brings forward a Markdown reader, a raw file tab or another shipped
  file the browser has open: the app window takes the pane, or the app opens on it.
- An alert, a reload or a new window naming a PC removed since now opens this PC with "That
  link's PC is not set up here" instead of an empty pane. An alert for a PC set up elsewhere since
  the tab last looked waits for a fresh list of PCs instead of being dropped.
- An alert for a pane that has closed (a terminal ended) opens the workspace it was in and says so
  in the header, as a link to it does, also when the phone delivers the tap twice.
