### Fixed
- A password sent to a mirrored terminal is no longer submitted after the sender leaves the pane
  or switches to view-only mode; the typed characters are erased before reporting the refusal.
- Mirrored terminals refuse passwords containing non-ASCII characters before typing anything,
  so cancellation can erase every accepted character on Windows as well. Attached terminals
  continue to accept Unicode passwords.
