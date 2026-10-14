### Maintenance
- The pane paging browser check waits for the demo's opening turn to end before it measures scroll
  positions: that turn ends 4.5 s after load and changes the transcript's height, which broke the
  check on a loaded runner.
