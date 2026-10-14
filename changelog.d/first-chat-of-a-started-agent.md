### Fixed
- An agent started from New workspace, New tab or New worktree opens its chat on the greeting over
  the message box. Codex, Claude Code, OpenCode, gjc and Grok write no session before the first
  message, so their chat said "Conversation unavailable" until then. A worktree's agent also opens
  in the same lens a new workspace's does.
- The message box of a chat not begun names the model, read from the agent's own start screen:
  Claude Code's model, and the model and reasoning effort of Codex and gjc. It was blank until the
  first message wrote a transcript.
- An agent started from the app reads READY until its first turn. Codex drawing its start screen
  read as working and then DONE, on a pane nobody had asked anything of.
