### Fixed
- Several devices or polls reading one GJC chat at the same moment now share a single lookup
  instead of each starting the GJC CLI (about 0.7 s apiece).
