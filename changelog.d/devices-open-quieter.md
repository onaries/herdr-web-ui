### Changed
- Settings → Devices shows one red warning, not two, while nothing is paired and no token is
  set: the note on what pairing turns on is a plain hint now, and it tells someone whose proxy
  already signs people in to set `HERDR_WEB_TOKEN` and have the proxy send it. The guide's
  **Behind a reverse proxy** shows the Caddy and nginx lines. Who gets in is unchanged.
### Fixed
- A browser that gets in with a token its proxy sends in an `Authorization` header no longer
  offers **Sign out**, which cleared nothing: the proxy sent the token again with the next
  request. `/api/health` marks such a sign-in with `auth.bearer`.
