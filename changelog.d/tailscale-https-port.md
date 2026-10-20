### Added
- `HERDR_WEB_TAILSCALE_HTTPS_PORT` names the HTTPS port the installer publishes the app on with
  `tailscale serve`, so 443 can stay free for something else. Settings → Phone & devices suggests
  that port too. When another service already uses it, the installer stops and says so instead of
  taking another port, which would move the address an installed app opens.
