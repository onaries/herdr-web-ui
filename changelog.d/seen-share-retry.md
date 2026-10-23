### Fixed
- Read finishes shared with other browsers now retry network and proxy errors with shared backoff,
  and resume after signing in again through one authentication check for all pending finishes,
  without resending on every sidebar update.
