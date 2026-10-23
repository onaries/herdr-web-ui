### Fixed
- Native Codex skills on Linux use the first CODEX_HOME or HOME environment value, matching Codex.
  CODEX_HOME must resolve to an existing directory, following symlinks before parent components as
  Codex does. Relative paths use the Codex process's own directory; unresolved paths keep scanned skills.
