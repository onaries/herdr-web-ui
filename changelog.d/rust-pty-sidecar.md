### Maintenance
- An experimental Rust PTY host (`crates/pty-sidecar`) speaks the Node sidecar's protocol; the
  server runs it in place of the Node sidecar only with `OVIS_PTY_SIDECAR=rust` and a built binary.
