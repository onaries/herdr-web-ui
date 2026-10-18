### Fixed
- A rendered HTML page plays its own videos and sounds too large to put into it (over 8 MB, or
  past the page's 32 MB) instead of showing an empty player: each plays from an address only that
  render hands out, for 30 minutes and only to the network address that opened the page.
  `HERDR_WEB_MEDIA_ROOTS` names folders, such as a network share, that a symlink beside the page
  may lead to for such a video
  ([#1188](https://github.com/devswha/herdr-web-ui/pull/1188) by @JensR93).
