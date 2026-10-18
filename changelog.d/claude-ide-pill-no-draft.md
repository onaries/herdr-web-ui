### Fixed
- A message sent from the chat to Claude Code with an editor connected is no longer refused as if its
  input box held a draft: Claude's `[⧉ … selected]` / `[⧉ In <file>]` pill there is not typed text,
  and Claude's suggested next prompt shows again beside it.
