# Agent input-row screens

Recorded 2026-10-22 in an isolated herdr session (herdr 0.9.5) for the terminal peek's automatic
return (`src/lib/inputRow.ts`, `src/lib/terminalPeek.ts`), read by `src/lib/inputRow.test.ts`.
Each agent ran in a scratch project folder under a temporary directory; every command was sent bare,
its screen held open, then closed with Escape (or `q` for Codex's `/diff` pager).

- `<agent>/<command>-<state>-<cols>.ansi`: one screen as `herdr pane read --format ansi` gave it
  (SGR only, one line per row, 40 rows). States: `idle` before the send, `open` with the command's
  screen up, `closed` after Escape (`closed-q` after `q`), and the few named states the recorder
  kept (`open-early`, `open-loading10s`, `typed-autocomplete`, `after-first-enter`).
- `<agent>/<name>.frames.jsonl`: herdr observe frames (`terminal.frame`) decoded to text, one per
  line as `{cols, rows, data}`. Each frame is one synchronized-update block, as the attach stream
  draws it.

Versions: Claude Code 2.1.308 (`claude/btw-*`, signed out, so the answer is an API error; default and fullscreen renderers), Codex 0.163.0, omp 18.8.7, pi 0.86.0, gjc 0.18.12, OmO 5.1.40 (`omo`), Hermes Agent
0.21.5 (classic CLI), Devin 3000.11.92, Antigravity CLI 1.4.4 (`agy`), Grok 1.0.67.

Redacted: account emails read `user@example.test` and account plans `(plan 00)` / `(Demo plan    )`,
both at their original width so the layout is unchanged; session and request ids are zeroed. The
Codex screens that still show an earlier `/status` card above the composer (the 40-column ones,
`diff-closed-q-120` and `diff-send-120`) read `00000` credits and a weekly limit that resets
`0:00 AM on 01 Jan`, with the session id all zeros. In the observe frames an email or id drawn in
pieces was mapped piece by piece (where herdr's diff skipped a cell the zeroed text no longer
matched, the frame writes it out), and each frame was replayed to check that none is left.
Screens opened to list the account's own sessions, usage, MCP servers or status (Codex `/status`,
gjc `/sessions` open, Devin `/status` and `/mcp`, agy `/resume` and `/usage`) are not here. The
scratch folder paths under the temporary directory are kept.
