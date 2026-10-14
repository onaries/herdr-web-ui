### Fixed
- The Windows installer assigns `gh` to a job before allowing a shim to start a child that keeps
  its output open: the job ends with the call, and its output pipes are closed. If Windows refuses
  job assignment, the existing launcher-based cleanup remains, without guaranteeing orphan cleanup.
