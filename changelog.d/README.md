# Changelog fragments

A PR that changes something users notice adds one file here instead of editing
[CHANGELOG.md](../CHANGELOG.md): every PR appending to the same `## [Unreleased]` lists was the
repo's most frequent merge conflict. Do not edit CHANGELOG.md in a PR.

- Name the file after the change, lowercase words joined by `-`, ending in `.md`
  (`composer-attach-limit.md`). Any unique name works; the release lists fragments by name.
- Write it exactly as the lines would read in CHANGELOG.md: a `### Added`, `### Changed`,
  `### Removed`, `### Fixed` or `### Maintenance` heading, then one or more `- ` entries,
  wrapped at about 100 columns with two-space continuation lines and no blank line inside an
  entry. One file may hold several sections.
- Leave out the PR link and your name: the release adds the link of the PR that merged the file
  (to each entry that does not link it already), and a maintainer adds `by @login` for outside
  contributors. A link you write yourself is kept.

```md
### Fixed
- A pasted image no longer disappears when the composer is resized while it uploads.
```

`scripts/changelog-fold.test.ts` checks every file here (and that CHANGELOG.md holds no conflict
markers). At release, `bun scripts/changelog-fold.ts X.Y.Z` moves the existing Unreleased notes and
these fragments under the new version and deletes the fragments; the release workflow refuses to
tag while a fragment is left here.
