# herdr-web-ui

Browser UI for the herdr terminal multiplexer: a React 18 + xterm.js client (`src/`) and a Bun.serve backend (`server/`) that bridges herdr's newline-JSON unix-socket API. `shared/` is the wire contract both sides import.

## Scope

- This file, `server/AGENTS.md`, `src/AGENTS.md`, `scripts/AGENTS.md` and `shared/AGENTS.md` are committed and apply to every agent working on the project, forks included. A PR is checked against them together with `CONTRIBUTING.md`, `.github/REVIEW.md`, `docs/development.md` and `DESIGN.md`.
- They hold only what the code and those documents do not show. Commands, layout, environment variables and release steps are in `docs/development.md` and `package.json`; do not copy them here.
- Read `server/AGENTS.md` before editing `server/` and `src/AGENTS.md` before editing `src/`; likewise `scripts/AGENTS.md` for `scripts/` and `shared/AGENTS.md` for `shared/`.
- "Maintainer workflow" applies only to the maintainer. Everyone else follows `CONTRIBUTING.md` for branches, PRs and the changelog.

## Bridge invariants

The app is only a bridge: herdr owns every pty, scrollback and agent state.

- NEVER load node-pty inside Bun; it panics the runtime (oven-sh/bun#18546). All PTY work goes through the Node sidecar `server/pty/pty-host.mjs`, and the only process it runs is `herdr terminal attach <terminal_id>`.
- NEVER pass `--takeover` to `herdr terminal attach` on the server's own initiative: an attach, a retry or a reconnect waits for the holder instead. Only a user's explicit request for that pane, from an interact connection, may take it. Always set `HERDR_SOCKET_PATH` to the socket the RPCs use.
- NEVER give xterm scrollback (keep `scrollback: 0`), and never rebuild an attached terminal from `pane.read`. The attach byte stream is the source of truth; only a mirrored pane (below) is drawn from `pane.read`.
- NEVER edit `shared/herdr-api.generated.ts`. Run `bun run generate:types`.
- NEVER pool herdr RPC connections: herdr closes the socket after each response. Use one connection per call (10 s timeout). Only `events.subscribe` stays open, and a second subscribe on an open connection is silently ignored, so reopen it with the full set.
- `pane.process_info` takes `pane_id`, not `target`. Given `target`, it silently answers for the focused pane.
- `server/collector.ts` is the only status subscription source. Do not subscribe to status anywhere else.
- Nothing the user typed is ever queued or sent automatically while offline. Keystrokes go to a draft the user sends or discards. An explicit chat Send while an agent works can enter the bridge's pending list on `pending-input` bridges: the next turn and its explicit Send now action claim the same server ID. Automatic delivery requires the original live connection and pane lease; disconnect/reload never resumes it. Existing browser-held messages still require "Send now".
- Prompt answers are `send_keys` navigation, never digits, and go through `POST /api/pane/prompt/answer`: the key semantics per agent live on the server.
- Web push: build requests with `generateRequestDetails` and send them with `fetch`; never call `sendNotification`.
- The omo transcript is found through the process tree, never through `pane.agent` or file mtime.
- Windows x64 has no PTY sidecar: herdr there cannot `terminal attach`, so the server mirrors the screen (`server/mirror.ts`). A Linux or macOS PC without Node for the sidecar is mirrored the same way. Do not assume a pty exists.

## Changing a contract

- HTTP and WS shapes live in `shared/protocol.ts`; change both sides through it and add a contract test (`server/api.contract.test.ts` for endpoints).
- Every push to `main` redeploys the site and the demo. A new endpoint or WS frame needs an answer in `site/demo/transport.ts`, or the demo gets a 404.
- The demo is the client itself: `site/demo/transport.ts` also imports `shared/` and `rollupStatus` from `src/lib/status.ts`, so a change there changes the demo.
- `site/demo/fixtures.ts` is bundled into the browser and reused by `scripts/readme-media/stage.ts`: keep it fictional and free of server imports.
- Every error body is `{ error: { code, message } }`, built only with the helpers in `server/http.ts`.
- Mutating machine, device and update POSTs require same-origin plus the `x-herdr-machine: 1` or `x-herdr-update: 1` header.
- Route order in `createServer().fetch` matters: bridge, then machines, then `/ws`, then the `/api/*` handlers, then a 404 for the rest of `/api/*`, then static files.

## Code conventions

- Imports carry explicit `.ts`/`.tsx` extensions and relative paths. The `@shared/*` alias is configured but unused; do not start using it.
- Wire fields are snake_case (`pane_id`) and code is camelCase (`paneId`).
- `createServer(options)` is the only injection seam; an unset option falls back to the environment.
- State files are written to a temp file and renamed, files 0600 and directories 0700.
- Wait with bounded polls and deadlines, never fixed sleeps.
- Multi-PC: pane and workspace calls go through `useMachineApi()`, and storage keys use `paneStorageId(machineId, paneId)`. Never use a mutable global target in async work.
- Component CSS is colocated and uses tokens only: no color literals, no `!important`. `DESIGN.md` must match the token values in `src/styles.css`; no test checks this, so update both together.
- Endless animations use `steps()` or `var(--ease-pulse)` (`src/motion.test.ts` enforces it).
- i18n: the English string is the key and must be a string literal. Every new `t("…")` needs an entry in `src/lib/i18n.ko.ts`, `i18n.ja.ts` and `i18n.zh.ts`; `i18n.test.ts` fails on a missing, unused or untranslated entry.
- Shortcuts are Mod+Shift+key so the pty keeps Ctrl+key. To add one, update `SHORTCUTS`, `KEY_TO_ID` and the switch in `src/lib/shortcuts.ts`.
- Icons come from lucide-react only; brand marks live in `AgentMark.tsx`. When icon files change, bump the `?v=` query in `index.html` and `CACHE_NAME` in `public/sw.js` together.
- UI wording: "New workspace", not "New session". "Session" means the herdr server session or an agent's history.
- There is no linter or formatter. Through `tsconfig.tools.json`, `bun run typecheck` also checks
  these critical tooling entrypoints and their imports: `scripts/check.ts`, `scripts/build-site.ts`,
  `scripts/ci-lanes.ts`, `scripts/ci-tests.ts`, `scripts/release-notes.ts` and `site/demo/transport.ts`.
  Other files in `scripts/` and `site/` are not broadly typechecked, so run what you change there.
- `vite.config.ts` reads `THIRD_PARTY_NOTICES.md` at build time and ships it in `dist/`.

## Testing

- `bun:test` only, with no DOM. `src/` tests cover pure logic in `lib/*.test.ts`; component behavior is covered by the Playwright scripts. A `.test.tsx` file is not discovered.
- A test that needs a live herdr is named `*.contract.test.ts`; without that name it runs in the unit suite, except the paths `scripts/ci-tests.ts` lists. Unit tests run with `HERDR_TEST_MODE=unit` and never touch herdr.
- `bun run check fast` is CI's Fast checks and `bun run check full` adds its two lanes, on a herdr of the run's own that reads nothing from the user's config. Lane and `check run` invocations take one of a few PC-wide slots (`CHECK_MAX_RUNS`), one per checkout: a run that finds no slot, or another run in its checkout, exits and names the holders. Reports and browser build provenance follow [Checks](docs/development.md#checks); an old report does not verify edited or restacked code.
- Single file: `HERDR_TEST_MODE=unit bun test ./server/prompt.test.ts`. The `./` is required.
- The unit suite is `bun run test:unit`. A bare `bun test` also loads every `*.contract.test.ts`; under `HERDR_TEST_MODE=unit` those fail, since unit mode points `HERDR_SOCKET` at a socket that does not exist.
- `bun run test:ui` does not run `scripts/file-viewer-regression.ts`; CI does.
- Tests run on an isolated herdr session (`herdr-web-ui-test`, or `-1` to `-4` under `bun run test:integration`), never the user's. Stop a leftover one with `herdr --session herdr-web-ui-test server stop`.
- Each `describe` creates and closes its own `herdr-web-ui-test-<purpose>` workspace with `focus:false`, and mutates only panes it created.
- Every `createServer` in a test gets a temp `stateDir` from `mkdtempSync` and `port: 0`. The default state dir is the user's real devices directory.
- Transcript caches are module-global; tests call `forgetTranscriptState()`.
- NEVER run the real `herdr update` in a test: it replaces the herdr on PATH.
- `scripts/generate-protocol-types.test.ts` rewrites the generated file while it runs; do not edit that file during a test run.
- Two servers cannot attach the same pane: the second gets `attach_held` and waits for the holder. For QA, use a pane the live server does not hold.
- Screenshots and recordings come from the `herdr-web-ui-demo` or a test session, never the user's live session. Playwright scripts serve `dist/`, so build first.

## Maintainer workflow

- PRs only, squash merged; the title is `type(scope): summary` and the merge adds `(#N)`. `main`
  requires the "Fast checks", "Integration and browser" and "Native Windows install" (GitHub App
  ID `15368`) checks, plus every review thread resolved.
- Contributors branch from `main`; the only exception is an explicitly maintainer-managed stack for genuinely dependent work. See [coordinated work](docs/development.md#coordinated-work) for task ownership, restacking, and authorization rules.
- Release steps are in `docs/development.md#releasing`. NEVER push a `v*` tag by hand: installed updaters act on tags alone.
- Changelog entries end with the PR link, plus `by @login` for an outside contributor: `… ([#208](https://github.com/devswha/herdr-web-ui/pull/208) by @login)`.
  - Write the full link (GitHub leaves a bare `#208` unlinked in CHANGELOG.md) and keep `@login` bare (it is what lists the contributor in the GitHub release).
  - Link the PR, not the issue. An entry built from several PRs links each one.
  - Credit every PR author except @devswha and bots, also when the maintainer pushed fixes to the PR or carried it into a new one; then link both, with `by @login` after the PR that person wrote.
  - A PR has no number until it opens, so add the link in a commit after `gh pr create`. At release, fill in missing links and credits from `git log --format=%s <last tag>..main` and `gh pr view N --json author`.
