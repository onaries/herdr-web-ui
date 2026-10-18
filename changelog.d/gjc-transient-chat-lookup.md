### Fixed
- GJC chat keeps the displayed conversation while a temporary SDK lookup failure is retried,
  instead of briefly replacing it with terminal fallback. Missing or changed sessions still
  undergo the same identity checks
  ([#1295](https://github.com/devswha/herdr-web-ui/pull/1295) by @Kinetic27).
