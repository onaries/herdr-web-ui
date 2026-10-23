### Fixed
- Bound skill and custom-command discovery by directory entries and file reads as well as folder
  visits, so linked folder lattices cannot repeatedly scan and read the same files without limit.
  Claude and Devin now share those limits across all skill and command roots in one discovery.
  Missing optional ignore files do not consume read allowances, and reaching the command read
  limit preserves the completed visible rows.
