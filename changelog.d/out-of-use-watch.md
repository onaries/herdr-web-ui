### Fixed
- A terminal opened, reloaded, or reconnected in a background window watches its pane without
  acquiring an attach that could change the pane's size. Returning to the window attaches normally;
  queued messages, mirrored panes, embedded pages, and older bridges keep their existing behavior.
