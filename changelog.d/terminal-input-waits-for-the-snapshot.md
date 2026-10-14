### Maintenance
- The terminal input check waits for the snapshot before it asks for a liveness probe: on CI the
  snapshot can follow the pane's first frames by a few milliseconds, and a wake before it probes
  nothing.
