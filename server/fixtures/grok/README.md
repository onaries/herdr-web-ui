# Fictional native replay capture

Captured with Grok CLI 1.0.50 (c58f321264ba), an isolated temporary Grok home,
and a loopback fake model on 2026-10-10. No account credentials or user history
were used. The session ID is replaced by `fictional-session`; envelope event IDs
and agent timestamps are removed. Text and event ordering are preserved.

`nested-rewind.jsonl` is the physical log after native conversation-only rewinds
to prompt indices 1, 1, and 0 and replacement prompts. `native-replay.jsonl` is
the final native `session/load` replay. The six physical user records reduce to
one active user prompt. The test compares visible messages rather than transport
timestamps. These captures establish rewind/display behavior, not TUI session
identity or tool patch semantics.

`native-tool.jsonl` was captured separately with the same native Grok version and
a loopback fixture model. It requests a fictional printf command, then records
one call and two updates. The completion omits rawInput and replaces content.
Session/prompt IDs and local paths are normalized; envelope metadata is removed.
Native tool metadata and raw input/output shapes are retained. This confirms the
native name and ordinary tool merge path; null updates and diff replacement still
use synthetic contract fixtures.
