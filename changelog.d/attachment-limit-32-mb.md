### Changed
- A file up to 32 MB can be attached in the composer (it was 8 MB).

### Fixed
- A file picked in the browser over the attachment limit is refused with the size message
  before it is uploaded, rather than ending in a blank 413 the browser cannot explain.
