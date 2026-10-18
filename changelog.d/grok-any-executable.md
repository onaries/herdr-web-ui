### Fixed
- Grok chat on Linux follows any Grok executable named `grok` or `grok-…`, including builds
  newer than 1.0.50, when that process holds one `events.jsonl` for the session Herdr
  reported. macOS and Windows still show the terminal view.
