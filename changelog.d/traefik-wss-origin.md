### Fixed
- A browser connecting through a TLS-terminating Traefik proxy no longer stays on Reconnecting
  because its secure WebSocket upgrade was mistaken for a different origin.
