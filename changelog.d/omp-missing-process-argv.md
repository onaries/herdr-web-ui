### Fixed
- OMP chat finds the pane's transcript on Linux when Herdr reports its process without command-line
  arguments, including sessions in a named profile. Process-memory reads have a deadline and run
  outside the bridge so a stalled WSL process cannot freeze it.
  ([#1157](https://github.com/devswha/herdr-web-ui/pull/1157) by @christso)
