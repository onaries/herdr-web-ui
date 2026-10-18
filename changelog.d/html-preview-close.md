### Fixed
- An HTML page previewed from a chat link closes again with X, the scrim and Escape after it
  navigated inside its frame (a click on its table of contents, a script setting `location.hash`
  once it had loaded); until now the preview stayed open and later file links opened nothing.
