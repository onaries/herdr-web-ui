### Fixed
- A connection that went dead without closing (a phone moving from Wi-Fi to cellular, or waking
  after its network changed) no longer leaves the terminal frozen while it still shows connected.
  The app checks the connection when the page comes back, the network changes or nothing arrived
  for 20 seconds, and reconnects when two checks a few seconds apart get no answer; a slow link
  gets longer each time it is dropped. Keys typed during the check are kept as held input instead
  of being lost, and a message sent during the check waits for the answer instead of failing. The
  key bar comes back as soon as the answer does, and a PC on an older version is no longer dropped
  after a reconnect.
- Once terminal input is held, later typing joins the held input until you send or discard it,
  also after the terminal is ready again: a command is never split between the held text and the
  terminal, and Enter never runs the part that already reached it. Ctrl+Enter, a paste the held
  input cannot take (a tab, for one), the input line's Send and the message box's Send (a queued
  "Send now" too) are refused with a note saying to send or discard the held input first.
