### Fixed
- A long diff drawn without colors (too long to highlight, or highlighting off) no longer redraws
  every one of its lines on each scroll: it builds only the rows in view, as long files already
  do, so each scroll step of a 10 000-line diff blocks the page about half as long.
