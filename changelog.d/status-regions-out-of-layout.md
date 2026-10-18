### Fixed
- The empty status boxes that stay in the page for screen readers (the header's note, the
  terminal's wait for input) no longer reach into layout: the note's sentence has its own class, so
  the pane title alone carries the header title's, and the clipped wait region sits at the banner
  column's corner instead of widening the column by a pixel.

### Maintenance
- The browser checks that read the header's note select it by `.header-note`; `.context-title-text`
  is the pane title alone, which the mobile tabs check measures.
