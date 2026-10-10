# shared/

The HTTP/WS contract plus the few policy modules the browser and the server have to agree on. A hand-written change here changes both sides at once; the generated file is regenerated, never edited.

## CONTRACT
- `protocol.ts` carries the route catalogue in doc comments above the types: method, path, answer and the quirk of each one. Voice routes are catalogued in `voice.ts` the same way. A route changed without its comment leaves that index wrong.
- Importing a VALUE from `protocol.ts` also evaluates `HERDR_SOCKET_PATH`, which reads `process.env` at module scope. Constants the browser needs therefore live in their own files (`attachments.ts`, `terminal-flow.ts`); keep `src/` imports from `protocol.ts` type-only.
- The generated herdr types are re-exported from here, and `generate:types --check` compares them with the saved `scripts/herdr-schema.json`: a herdr upgrade shows only after `--refresh` re-reads its schema, so refresh first instead of trusting a passing check. Their string enums arrive widened with `(string & {})`: never narrow one back to a closed union.
- `HerdrPane` is herdr's `PaneInfo` widened with `background_tasks`. The bridge's own additions to a herdr type belong on an alias here, never in the generated file.
- `ServerFeature` is what a client checks before it uses `submit`, `pending-input`, `secret-input`, `input-ready` or `take-over`: an older server simply omits one, so never assume a frame is supported.
- `patch.test.ts` and `secret-prompt.test.ts` are the only tests in this directory; other shapes are held by the server's contract tests and the client's unit tests.

## ROUTE SHAPES
- Legacy paths and a missing machine ID still mean the local PC. `/ws?machine_id=` fixes the target for the life of the socket, with the role and output-ACK protocol unchanged.
- `GET /api/health?scope=bridge` answers without waiting for herdr, which is what makes it usable while herdr is down.
- `/api/pane/scroll` reports where the viewport sits as `max_offset_from_bottom - offset_from_bottom`, and posting an offset makes herdr redraw every attached terminal: it is not a client-local scroll. `/api/pane/find` returns native inclusive cell ranges (at most 1024 around the result), an exact total and scroll metrics. `matches` and `scroll` stay optional for older bridges; their presence on an explicit response is what permits automatic `jump:false` refreshes. Never probe an older bridge with `jump:false`: it may ignore that field and move the shared view.
- `/api/pane/selection` takes both cells inclusive, counts rows from the top of the history and joins soft-wrapped lines, so a selection outlives one screen.
- `/api/agents` lists herdr's own agent manifests plus omo and gjc when they are on the server's PATH, so the dialog can offer a kind `agent.start` would refuse.
- `UsageReport` names only the providers a CLI on this PC is signed in to, once per account, and a provider that could not answer is reported as a `UsageProblem` (`expired`, `rate_limited`, `failed`, `locked`) rather than left out.

## SHARED POLICY
- `notify-policy.ts` is shared by the browser's tab notifications and the server's web push on purpose, so a device with the app open and a phone with it closed judge an event by the same rule; permission, preferences and subscriptions still decide what each path shows. A new rule belongs here, not in either caller. `paneNotificationTag` gives one slot per pane, and a newer notification replaces the older whichever path showed it.
- Unknown alert values fall back to the default (`parseAlerts`, `alertsAllow`): a device must never lose its alerts to a typo or to a field a newer build writes.
- `machines.ts` `terminal_attach: false` is a working PC with the chat lens and a mirrored terminal, not a broken one. It is false on a Windows host (herdrdev/herdr#4821) and on any bridge whose runtime ships no PTY sidecar, and absent on older bridges that do not report it.
- `update.ts` release summaries are keyed by the app's own languages (`src/lib/i18n.ts`): a language the release did not write is absent, and a list with no line is absent rather than empty.
- `voice.ts`: `base_url` moves only together with `api_key` while a key is saved, and never while the environment sets the key, so a saved key cannot be pointed at a server other than the one it was saved for.

## ANTI-PATTERNS
- `secret-prompt.ts` is deliberately narrow: prose that mentions a password must not become a secret input. A secret is one line of literal keystrokes and never terminal controls, and only a row that reached the right edge may be joined to the next, because herdr's screen-diff stream does not preserve xterm's soft-wrap flags.
- Secret input is never queued, retried, sent through `agent.prompt` or echoed in a result, and a queued message does not resume after its lease is lost.
- Never replay terminal input across a disconnect, acknowledge pty output before xterm's write callback ran, repaint raw pty bytes over the terminal, or let an observe-role client input or resize. `protocol.ts` documents most of these on their frames; the client and the server enforce them.
- `MAX_ATTACHMENT_BYTES` is checked by the browser before it reads any of a file and again by `POST /api/pane/image`. Raising the number alone is not enough: the upload is one JSON body the server holds whole.
- `patch.ts` has to find Codex's patch in both carriers — `apply_patch`'s whole input, and the string argument of `tools.apply_patch(…)` inside an `exec` script — or the edit reads as a raw blob with no file names.
- `background_tasks` is absent from a snapshot when none run, and a `pane-status` frame sends 0 to clear an earlier count. `ConversationResponse.source` is `"scrollback"` when the pane has no recognized store: the chat is read off the screen, which says nothing about whether the agent has a history.
