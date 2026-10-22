# Session history fixture stores

Small synthetic stores, one per agent, for `server/session-history.test.ts`. Each follows the
layout and record shapes its agent documents or writes (see the comments in
`server/session-history.ts`); every id, prompt and title is made up, and no user history was used.

Paths are relative to a home directory, its dot-folders spelled `dot-<name>` (the repository ignores `.omo/` and `.gjc/`): `dot-claude` is `~/.claude`. A path segment `@folder` stands for the folder the agent
names after the session's cwd, and the token `"{{CWD}}"` (quotes included) for that cwd as a JSON
string; the test fills both in for its own fictional cwd. A `.sql` file is the script for that
agent's SQLite store (the `.db` beside it), with `:cwd` and `:uris` bound by the test.

Each store holds two sessions in the cwd (`...0001` older, `...0002` newer) and sessions that
must not be listed: another folder's, a subagent's, an exec run's, a hidden one.

The Codex store here has the header shape of a Codex older than `thread_source` and `session_id`
(made-up `cli_version`). Which Codex rollout headers count as an interactive conversation of
their own is pinned by `../codex-rollout-headers.json`, a table that `server/codex.test.ts`,
`server/session-history.test.ts` and `server/codex-binding.contract.test.ts` all read. Its
`native` rows are first lines that Codex 0.162.1 (TUI, `codex exec`) and 0.163.0 (Codex Desktop
thread and subagent) wrote on Linux in October 2026, with every id, path, account id, git detail
and instruction text replaced and the relations between ids kept (a subagent's `session_id` and
`parent_thread_id` name its parent, as openai/codex#29327 has it). Its `synthetic` rows vary one
field of those shapes each.
