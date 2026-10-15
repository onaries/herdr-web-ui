### Fixed
- Claude's plan card shows the whole plan, not only the part that fits the pane: the text comes
  from Claude's plan file (`<config dir>/plans/<slug>.md`), and **View plan** opens that file in the
  file viewer as Markdown. A session without a plan file shows the screen's text, as before.
  ([#855](https://github.com/devswha/herdr-web-ui/pull/855) by @sergiorademacher)
