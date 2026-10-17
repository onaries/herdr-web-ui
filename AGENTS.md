# herdr-web-ui

Browser UI for the herdr terminal multiplexer: a React 19 + xterm.js client (`src/`), a Bun
backend (`server/`) that bridges herdr's unix-socket API, and the wire contract both import
(`shared/`). herdr owns every pty, scrollback and agent state; this app is only a bridge.

These files hold only the traps the code and tests do not show. Commands, layout, checks and
release steps are in [docs/development.md](docs/development.md); contributors follow
[CONTRIBUTING.md](CONTRIBUTING.md). Code conventions (imports, CSS tokens, i18n entries, fixed
sleeps, wording, icons) are enforced by the `conventions.test.ts` files, whose failures say what
to change. Also read [server/AGENTS.md](server/AGENTS.md) and [src/AGENTS.md](src/AGENTS.md).

## Bridge traps
- Never load node-pty inside Bun: it panics the runtime. PTY work goes through the Node sidecar.
- Never pass `--takeover` to `herdr terminal attach` on the server's own initiative; it cuts off
  whoever holds the pane. Only a user's explicit take-over request may.
- One herdr RPC connection per call: herdr closes the socket after each answer. Only
  `events.subscribe` stays open, and a second subscribe on it is ignored, so reopen with the full
  set. Caching answers is fine.
- `pane.process_info` takes `pane_id`, not `target` (with `target` herdr answers for the focused
  pane).
- Keep xterm `scrollback: 0` and never rebuild an attached terminal from `pane.read`: the attach
  stream is the truth. Only a mirrored pane (Windows, or no Node for the sidecar) is drawn from
  `pane.read`, so never assume a pty exists.
- Nothing the user typed is sent automatically after a disconnect: it waits in a draft until the
  user sends or discards it.
- Prompt answers go through `POST /api/pane/prompt/answer`, never guessed digit keys.
- Selecting a pane or tab in the browser never moves herdr's own focus; only an explicit action
  that needs it calls `pane.focus`.
- Never edit `shared/herdr-api.generated.ts`; run `bun run generate:types`.

## Tests and QA
- Tests never touch the user's herdr session or real state: they use the isolated test session,
  a `mkdtempSync` `stateDir` and `port: 0` for every `createServer`. Never run the real
  `herdr update` in a test.
- Screenshots and recordings come from the demo or a test session, never the user's live one.

## Maintainer workflow
- A session that changes code, in any harness, stops at an open PR: only the maintainer's merge
  pass merges, unless the maintainer asks that session to merge. One session that edits files per
  worktree; read-only sessions may share it.
- Everything written to git and GitHub (commits, branches, PRs, reviews, issues, changelog
  fragments) is in English.
- Never push a `v*` tag by hand: installed updaters act on tags alone.
- Required checks: Fast checks, Integration and browser, Native Windows install. Resolve review
  threads before merging (branch protection does not enforce it).
- Changelog entries go in `changelog.d/` fragments ([format](changelog.d/README.md)), not
  CHANGELOG.md; only a release folds them in.
