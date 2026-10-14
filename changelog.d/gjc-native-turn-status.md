### Fixed
- A Gajae Code pane's status now comes from gjc's own session transcript instead of what herdr
  reports for the pane, which could keep a finished turn at RUN for work a provider child was
  still doing — and a turn gjc ran while the child was quiet never read RUN or sent a done
  alert. A turn that ended in an error or was aborted reads READY rather than DONE, a
  background job's result that wakes the agent reads RUN, and a pane whose transcript cannot
  be told keeps herdr's status.
