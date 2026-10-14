### Fixed
- An OmO session started by a launcher that does not look like OmO (its own `OMO_CODING_AGENT_DIR`
  store, an arbitrary command name) now binds its chat only to the native session its live process
  verifiably holds in its own store. A newer file in another pane's store no longer takes its
  place, conflicting holds read as no session instead of guessing, and the chat follows the held
  session through /new and /resume.
