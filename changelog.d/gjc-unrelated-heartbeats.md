### Fixed
- GJC chat and status reuse their verified session binding when other sessions write heartbeats,
  instead of restarting the SDK lookup for every pane. Session changes still require SDK validation.
