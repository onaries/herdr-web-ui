### Added
- New workspace and New tab start an agent with its model, effort and first message where the
  agent's command line takes them (Claude Code and Codex: `--model` and the effort level; Codex also
  takes the message as its own argument, behind `--` so a message like `logout` is never a command).
  For Claude Code and every other agent the message is queued on the PC as the pane's first pending
  message and sent once when the agent is ready, through the page that started it; it shows as a
  pending message that can be discarded or sent now. If that page disconnects, reloads or leaves the tab
  first, the message is held, never sent on its own, until someone sends it now or discards it. A message the PC
  could not queue, or one an older PC ignores, stays in the new tab's message box and the dialog says
  so. Pending first messages are kept in memory: restarting the web UI's server drops them. A Codex
  message with a tab or a line break is sent as the first message rather than on its command line,
  and the PC refuses launch arguments with control characters, an unknown effort level or a model
  that is not one word. Under the message, the agent's skills in the
  folder are listed before it runs, each a chip that puts the skill as the agent types it into the
  message (`$name`, `/name`, or `@name` for OpenCode 2). A first message to OpenCode attaches its
  `@skill` as any Chat send does; before OpenCode has a session nothing tells its version, so the `@`
  is sent as the plain text it is.
  The chat's composer has a New tab with an agent… button that opens the dialog on the pane's
  workspace.
