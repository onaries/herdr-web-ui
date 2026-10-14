### Fixed
- A pane on another PC no longer stops after a short network stall on a phone: the relay now stops
  output only when 256 KiB stays queued for 2 s, the same rule as this PC, instead of on any queued byte.
