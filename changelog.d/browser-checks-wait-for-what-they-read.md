### Maintenance
- Four browser checks no longer fail on a slow run: the terminal input check waits for the
  connection before it asks for a liveness probe, the update line and plan-limit checks count a
  request once it has been answered or by the page that made it, and the phone transcript check
  reads the transcript's style in one step.
