### Added
- Codex's command menu now includes shared and ancestor-project skills, system skills and enabled
  plugin skills, grouped by origin. It honors the pane's `CODEX_HOME` and disabled skill paths,
  offers saved prompts as `/prompts:name`, and inserts skills as `$name`.
### Changed
- Codex's built-in commands now match its recorded palette, excluding screens the chat cannot
  represent. Project `.codex/skills` remains excluded because Codex loading it is unconfirmed;
  project skills come from `.agents/skills`.
