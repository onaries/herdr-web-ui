### Fixed
- A pane another web bridge holds no longer unlocks its input for a moment and shows the "held"
  notice twice when a busy herdr writes its refusal a little after the attach's teardown.

### Maintenance
- The pending-input "turn never starts" test waits for the recorder to log the bridge's Enter
  before comparing the bytes, instead of racing it.
