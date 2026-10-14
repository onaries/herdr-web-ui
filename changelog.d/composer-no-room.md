### Fixed
- A file whose `@path` has no room in a message near 20,000 characters says so: its tile reads
  "No room" and the status line says how many characters to remove. Removing that file lets the
  files picked after it in. Within 200 characters of the limit the status line counts what is left.
