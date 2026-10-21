### Added
- Chat lists the commands and skills an OpenCode v2 pane's own background service reports for its
  folder, refreshed when they change, and settles a command it sent from that session's own events.
  The service is only read, never started, and only when it is the process its service.json names.
- An `@skill` sent from Chat to OpenCode v2, at once or queued, is typed through OpenCode's own
  autocomplete so the skill is attached; when the row does not show, the message says the skill
  went as plain text and points to the terminal.
- An OpenCode 1.x question is a card in Chat with each option and its description, answered from
  the card.
- Chat lists a Codex pane's skills as the running Codex daemon of that pane's own Codex home reports
  them (Codex 0.157 or later; on Linux, or when the server's Codex home is set), and a gjc pane's
  skills as the SDK broker it is bound to reports them, asked through the gjc CLI in the background.
  The daemon and the broker are never started for this; without one, the skills read from disk stay.
