### Added
- A Grok pane's `/` menu now lists Grok's slash commands and the skills Grok loads for that pane:
  yours (`~/.grok/skills`, `~/.claude/skills`, `[skills] paths` in `config.toml`), this
  project's (`.grok/skills` and `.claude/skills` in the folder and the repository root, left out
  when `.gitignore` ignores them) and those of plugins. `$GROK_HOME` is honored, and typed
  `/name` skill names should show as chips in your messages. This is built from Grok's published
  README, not checked against a running Grok, which is not installed where this was written.
  Grok's built-in skills, which live inside its binary, are not listed.
