### Fixed
- Mobile Send no longer stays blocked by a stale composing state when the keyboard commits on blur
  without delivering compositionend. Composition confirmation keys still belong to the keyboard,
  and a disconnected pending Send is never replayed.
