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
