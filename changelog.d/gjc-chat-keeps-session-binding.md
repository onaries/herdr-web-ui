### Fixed
- A GJC pane's chat and status no longer start the gjc CLI on every refresh: the session found
  for the pane is kept until GJC's session index changes (a `/new` or `/resume` always writes
  it), the pane's gjc process changes, or half a minute passes.
