### Removed
- **Move pane to…** in the header's More menu, and `POST /api/pane/move` behind it. Move a pane
  in herdr's TUI; the app follows the roster as before.
- **Send right-clicks to pane** in the pane menu: a right-click on a pane always opens its menu.
- **New tab** in the header's More menu: the tab strip's `+` and the command palette open one.
- **Command palette** in a phone's More menu and **Browse folders in the palette** in its Files
  dialog. The command palette and its plugin actions are not available in the phone touch UI;
  use a wider screen or an external keyboard's Mod+Shift+K shortcut.

### Changed
- The pane header's `⋯` stays visible on touch screens and appears on keyboard focus on desktop;
  tab to it and press Enter, or right-click the pane with a mouse. Shift+F10 in the terminal
  stays with the terminal program.
- The tab's `⋯` on touch screens no longer lists New tab (the strip's `+` sits beside it).
  At widths that show one pane at a time, it omits Split right, Split down and Zoom pane, but
  keeps Unzoom pane so other panes remain reachable. Wider touch screens keep split and zoom.
