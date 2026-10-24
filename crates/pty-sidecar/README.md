# ovis-pty-sidecar

A PTY host written in Rust that speaks the protocol of `server/pty/pty-host.mjs`: the same argv
(`<cols> <rows> <command> [args...]`), the same newline-delimited JSON control frames on stdin
(`i` input, `r` resize, `p` pause/resume output reads, `w` SIGWINCH at the current size), the pty's
bytes on stdout, and the child's exit code. Linux and macOS only.

Its stdin is bounded: a control frame longer than 17 MiB is discarded up to its newline, and once
16 MiB of input wait for a command that is not reading (each frame counted with 80 bytes on top of its
own, empty ones not queued), further input frames are dropped (one stderr line per overflow) while
resize, pause and stop frames keep working. The command runs as the
leader of its own process group, which the host kills whenever it ends: the command exiting, a stop
(stdin closed, SIGTERM, SIGINT, SIGHUP, SIGQUIT, a broken stdout) or a crash (SIGABRT, SIGSEGV,
SIGBUS, SIGILL, SIGFPE). A host killed outright (SIGKILL) cannot do that: on Linux the command itself
is killed with it (`PR_SET_PDEATHSIG`), and the rest of the group gets the pty's hangup. After the
command exits, its output is read until EOF, 200 ms of quiet or 2 s; output paused then is held for
up to 15 s.

The server uses it only when `OVIS_PTY_SIDECAR=rust` is set; otherwise, on Windows, or when the
binary is missing, `PtySession` runs the Node sidecar as before (`server/pty/host.ts`).

```bash
cargo build --release --manifest-path crates/pty-sidecar/Cargo.toml
OVIS_PTY_SIDECAR=rust bun run server
```

`OVIS_PTY_SIDECAR_BIN` points at a binary elsewhere; the default is
`crates/pty-sidecar/target/release/ovis-pty-sidecar`.

## Checks

```bash
cargo test --manifest-path crates/pty-sidecar/Cargo.toml   # frame parsing
bun test server/pty/host.test.ts                           # the same PtySession checks on both hosts
OVIS_PTY_SIDECAR=rust bun test server/pty/session.test.ts  # the Node host's own tests, on this one
bun scripts/pty-sidecar-bench.ts                           # startup, teardown, echo, throughput, memory, a real attach
```

The Rust checks in `server/pty/host.test.ts` are skipped when the binary has not been built. CI does
not build it.
