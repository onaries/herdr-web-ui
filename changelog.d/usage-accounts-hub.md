### Added
- Add and manage subscription accounts from one provider picker in Settings, with official
  local CLI sign-in in a new terminal tab and CLIProxyAPI hub sign-in for Claude and Codex.
  All supported providers include installation or app sign-in guidance; single-home providers
  ask before replacing a discovered account.
- Connect a hub to import its Claude and Codex plan limits, edit the connection or remove
  its saved key with confirmation. The management key stays on the server, OAuth tokens
  are never refreshed here, and disabling plan limits stops provider usage requests.

### Changed
- Subscription accounts show their source, plan and sign-in status in provider groups,
  with existing ordering and visibility controls. Short setup copy is available in English,
  Korean, Japanese and Chinese.

### Fixed
- A damaged or unreadable hub configuration no longer prevents the web UI from starting.
  The hub stays unconfigured, and the server logs the problem without exposing its saved key.
