### Changed
- The chat and the composer say one thing per situation. While the socket is down the composer's
  placeholder is the one word "Connecting…" or "Reconnecting…" and the chat draws no connecting line
  of its own. A file whose path has no room shows a warning glyph on its tile and one status line,
  "20,000-character limit · 41 over", with no second limit line under the card. A slow chat read
  shows a muted "Waiting for the PC…" while the chat retries on its own, and only repeated failure
  shows "The PC isn't responding" with Try again. A failed upload or read names the cause it knows
  ("Couldn't attach · PC disk is full") or offers Try again, with the advice and the server's own
  words behind Details. The held-input notice over the chat's input card is the held text with send
  and discard glyph controls, with no label.
