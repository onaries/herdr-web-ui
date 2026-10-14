### Fixed
- A chat message sent to an OmO pane while it works is no longer refused as "Claude Code's input box
  is not empty": the input box under OmO's status rule (`── • Running …`) is read again.

### Changed
- When a chat message is refused because Claude Code's input box in the terminal may not be empty,
  and no draft can be named, the note shows what the box holds and offers **Send anyway**, which
  sends that message once into the same Claude terminal.
