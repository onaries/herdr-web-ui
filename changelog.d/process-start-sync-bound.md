### Fixed
- Limit synchronous macOS process-start probes to one second so a stalled probe cannot block
  conversation and pending-send checks indefinitely.
