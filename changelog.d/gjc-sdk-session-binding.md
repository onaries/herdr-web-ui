### Fixed
- GJC chat identifies its session through GJC's SDK broker instead of matching terminal
  answers or session titles. Copied output from another session can no longer select that
  session's conversation. This requires GJC 0.18.9 or later for its broker-bound SDK
  session CLI; an older GJC, or an unavailable or ambiguous SDK identity, uses Terminal instead.
  ([#912](https://github.com/devswha/herdr-web-ui/pull/912))
