### Maintenance
- The SSH password test pulls its disposable PC's image from a second and a third registry when
  one refuses the runner for its pull limit, instead of failing on a limit that is not the
  test's.
- The prompt dock check waits for the answered question's own card to go, not for any card: the
  demo's approval could take its place at once and the wait then ran out.
