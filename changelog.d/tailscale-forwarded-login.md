### Fixed
- Tailscale login headers forwarded by another local proxy no longer grant owner access unless
  the forwarded address is a single tailnet address. Header-free, serve-only owner access is preserved.
