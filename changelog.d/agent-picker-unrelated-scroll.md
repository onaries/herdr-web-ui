### Fixed
- The **agent picker** in the New workspace and New worktree dialogs no longer closes when an
  unrelated element scrolls, such as a text field scrolling its own text. It closes when the
  window resizes or when something that holds it scrolls. Moving through a long list with the
  arrow keys scrolls only the list, so the dialog no longer moves and closes the picker.
  ([#1010](https://github.com/devswha/herdr-web-ui/pull/1010),
  [#889](https://github.com/devswha/herdr-web-ui/pull/889) by @willowite)
