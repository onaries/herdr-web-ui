### Fixed
- The terminal's input line and grid now ask an Android keyboard for no word suggestions: they say
  `autocomplete="off"`, which Chrome turns into the keyboard's no-suggestions flag, and a keyboard
  that honors it hides its suggestion strip there. Gboard 18.4 ignores it and keeps the strip. The
  chat composer keeps its suggestions.
