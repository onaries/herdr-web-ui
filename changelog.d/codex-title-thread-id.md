### Fixed
- Codex Chat now finds a session resumed through the `codex resume` picker from another folder
  when Codex shows the thread id in its terminal title: add `"thread-id"` to `[tui].terminal_title`
  in `~/.codex/config.toml`. The title only offers that one conversation: the chat opens it once the
  pane's screen shows one of its longer answers (64 or more letters and digits) that no other
  conversation of the pane's folder also gave. An id that the pane's folder, or a stored
  conversation's folder or name as Codex shows them in the title, also contains is not taken. With Codex's default
  title, such a session still shows "Conversation unavailable", since nothing else ties the pane to it.
