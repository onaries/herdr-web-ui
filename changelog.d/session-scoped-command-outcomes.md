### Fixed
- Chat shows only the current agent session's command results: after an agent restarts in the same
  pane, the earlier session's commands no longer appear. A `/clear`, `/new` or resume sent from Chat
  keeps its own row in the conversation it starts, without claiming that it finished. Commands sent
  before an agent's first reply stay with that agent while it keeps running, also through a moment
  in the background (Ctrl+Z on Linux and macOS); once a different agent takes over the pane, they
  are hidden, even if Chat was not open when it happened. A command sent to a restarted agent while
  the pane still shows the previous session stays once the agent's own session appears within a
  minute, unless Chat started another session after it. Within that minute, a session change typed
  in the terminal of an agent that resumed the same session can still keep such a command. Where
  Chat cannot find the agent's program at all (native Windows, or an agent started under another
  program name), such a command stays with the session that the same agent starts in the same
  terminal; a later session, another agent or terminal still hides it. Outside Linux, an agent
  restarted under the same process number cannot be told apart from the one before it.
