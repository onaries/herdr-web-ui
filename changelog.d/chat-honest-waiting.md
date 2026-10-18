### Fixed
- The prompt card says "Sending your answer…" while an answer is on its way, and a refused answer
  or a failed chat read is told as a plain sentence with the PC's own words kept beneath it.
- Typing `@` when the PC cannot list the folder's files now says "Couldn't load suggestions"
  instead of showing nothing, as if no file matched.
- Screen readers hear when an attachment finishes ("photo.png attached") or fails, with the reason;
  the chat log is named by the pane's title instead of its id, and a picture a tool read is named
  by its number and the tool.
- A failed attachment's note over the message box says in plain words why it failed, with the PC's
  own words kept beneath it, instead of `/api/pane/image failed (500): ...`.
- With reduced motion, the prompt card's options and question chips change colour without fading.
