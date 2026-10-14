### Maintenance
- CI's browser lanes run a failed script a second time. One that then passes is reported as flaky
  (a warning on the run, its first log kept) instead of failing the job; one that fails twice
  still fails it.
