### Fixed
- On a phone, a sheet opened right after another one closed (before the browser had stepped back
  off the closed sheet's history entry) no longer closes at once.

### Maintenance
- `scripts/repo-diff-browser-qa.ts` waits for the diff's worker colors before it selects and
  copies rows: the colored redraw dropped a selection made on the plain rows, so the copy came
  back empty.
