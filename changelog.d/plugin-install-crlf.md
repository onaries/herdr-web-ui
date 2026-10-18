### Fixed
- Installing the herdr plugin on WSL no longer fails with `scripts/preflight.sh: 7: set: Illegal
  option -` when git there converts line endings (`core.autocrlf=true`): every text file is now
  checked out with LF.
