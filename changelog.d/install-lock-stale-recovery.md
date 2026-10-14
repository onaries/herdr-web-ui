### Fixed
- A bridge install that was cut off mid-upload no longer blocks later updates with "Another
  installation is in progress": a stale `install.lock` is reclaimed, and the upload is bounded
  ([#895](https://github.com/devswha/herdr-web-ui/pull/895) by @suho-han).
