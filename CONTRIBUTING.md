# Contributing

Thanks for helping. Bugs and ideas go in an [issue](https://github.com/devswha/herdr-web-ui/issues/new/choose);
security problems never do: see [SECURITY.md](SECURITY.md). For a larger change, open an issue first so
the approach can be agreed before you build it. Small fixes can go straight to a PR.

Everything a PR is checked against is in this repository: this file, the
[review rules](.github/REVIEW.md), the [development guide](docs/development.md),
[DESIGN.md](DESIGN.md) and the `AGENTS.md` files ([root](AGENTS.md), [server](server/AGENTS.md),
[src](src/AGENTS.md)), which hold the invariants that people and coding agents both follow.
Contributions are licensed under the repository's [MIT license](LICENSE). Say in the PR when code is
adapted from another project, with its license.

## Set up

- Linux (x64, arm64), macOS or Windows x64. Windows uses the screen mirror and needs no terminal addon; Alpine and 32-bit ARM have no addon build.
- Bun 1.4 or newer, Node 18 or newer on Linux/macOS (it runs the terminal-attach sidecar), herdr 0.9.0 or newer for
  the integration tests. CI runs Bun 1.4.2, Node 22 and herdr 0.9.3.

```bash
bun install
bun run server   # API + WebSocket on :7317
bun run dev      # Vite on :5173, proxies /api and /ws
```

Neither command updates itself; only `bun run start` and the plugin run the updater.

## Branches and pull requests

- Fork, branch from `main` (`feat/…`, `fix/…`, `chore/…`, `docs/…`) and open the PR against `main`.
  There is no `develop` branch; releases are `vX.Y.Z` tags on `main`.
- Independent changes should use independent PRs from `main`. The only exception is a stack explicitly
  managed by a maintainer for a genuine code dependency; code conflicts and approval gates are
  scheduling constraints, not reasons to stack. See the [coordinated-work procedure](docs/development.md#coordinated-work).
  Contributors must not assume elevated permissions or that a stack has been authorized.
- One change per PR. PRs are squash merged, so the PR title becomes the commit:
  `type(scope): summary`, for example `fix(chat): keep the finished turn finished after Send`.
  The merge adds `(#N)`.
- Fill in the [PR template](.github/pull_request_template.md): what changed and how you checked it.
- CI on a fork's PR waits until a maintainer approves the run. That approval is not a review.

## Checks

`bun run check fast` runs the **Fast checks** CI job, and `bun run check full` adds the
**Integration and browser** job, on a herdr of its own apart from the one you work in
([docs/development.md](docs/development.md#checks)).

**Fast checks** is these, one by one; none needs herdr:

```bash
bun run generate:types --check   # shared/herdr-api.generated.ts matches scripts/herdr-schema.json
bun run typecheck
bun run build
bun run test:unit
```

**Integration and browser** needs herdr on `PATH` (or `HERDR_WEB_HERDR_BIN`) and Chrome
(`CHROME_PATH`, default `/opt/google/chrome/chrome`):

```bash
bun run test:integration   # runs the files 4 at a time on `herdr-web-ui-test-1` to `-4`, which it
                           # stops itself; HERDR_TEST_SHARDS=1 runs them one by one on `-1`
bun run test:ui            # builds, then browser regression on `herdr-web-ui-test`; stop it with
                           # herdr --session herdr-web-ui-test server stop
```

`bun test` runs the unit and integration suites together. Remote-PC changes also have
`bun run test:ssh`. Tests and screenshots use panes and state they create themselves, never your
running terminals: see [development](docs/development.md#checks).

## What a change needs

- **HTTP or WebSocket contract:** change both sides through `shared/protocol.ts` and cover it with a
  contract test (`server/api.contract.test.ts` for endpoints). A test that needs a live herdr is named
  `*.contract.test.ts`.
- **herdr wire types:** never edit `shared/herdr-api.generated.ts`; run `bun run generate:types`.
- **UI text:** every new `t("…")` string needs an entry in `src/lib/i18n.ko.ts`, `i18n.ja.ts` and
  `i18n.zh.ts`, with the same placeholders. `bun run test:unit` fails on a missing, unused or
  untranslated entry.
- **UI:** component CSS uses the tokens in `src/styles.css` (see [DESIGN.md](DESIGN.md)); attach a
  screenshot or recording from a test or demo session.
- **The browser demo:** the [demo](https://herdrweb.dev/demo/) redeploys on every
  merge to `main`. A feature meant to show there needs an answer in `site/demo/transport.ts`; anything
  else gets its 404.
- **Changelog:** a change users notice gets a line under `## [Unreleased]` in
  [CHANGELOG.md](CHANGELOG.md) (`### Added`, `### Changed` or `### Fixed`). Do not bump versions.
  The link to your PR and your name are added by a maintainer at release, so you can leave them out.

## Releases

Maintainers only: see [development](docs/development.md#releasing). App releases are cut by the
Release workflow; never push a `vX.Y.Z` tag by hand, since installed updaters act on tags alone.
Remote-PC runtime bundles are released separately with a `remote-vN` tag.
