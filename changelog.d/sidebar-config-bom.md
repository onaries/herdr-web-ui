### Fixed
- Custom sidebar token rows are kept when herdr's config contains a byte-order mark at the start of
  a later line. Oversized or non-regular config files are ignored without waiting on a pipe.
