### Fixed
- The desktop terminal follows herdr's `[ui] copy_on_select` on the PC serving Ovis, for local and
  remote panes alike. With it off, letting go of a drag only selects, the selection stays when the
  pointer moves over the terminal, and Ctrl+C or Copy copies it; with it on (herdr's default),
  letting go copies as before. A Ctrl+C or Copy made before herdr has sent the text of a drag
  still copies that whole text, not only the rows on screen.
