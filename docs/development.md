# Development

## Run it

Run the server and Vite side by side:

```bash
bun install
bun run server   # API + WebSocket on :7317
bun run dev      # Vite on :5173, proxies /api and /ws
```

`bun run server` and `bun run dev` never update themselves; only `bun run start` and the plugin run the update supervisor.

## Checks

`bun run check` runs what CI runs, from the same script (`scripts/check.ts`):

```bash
bun run check fast                  # CI's Fast checks: workflow syntax, generated types, typecheck, build, unit tests
bun run check integration browser   # CI's Integration and browser: a build, then both lanes side by side
bun run check full                  # fast, then both lanes
bun run check run bun test --timeout 15000 ./server/api.contract.test.ts   # one command on the same isolated herdr
bun run check run bun scripts/ui-regression.ts                             # (a browser script serves dist/: build first)
```

`fast` needs no herdr. The other modes run on a herdr of their own: its config, its plugin state
and the web UI's state live in a directory made for the run (`XDG_CONFIG_HOME`, `XDG_STATE_HOME`,
`HERDR_WEB_STATE_DIR`), under a session name made for the run. Nothing reads your herdr config,
so no plugin installed there starts with the test servers, and two runs on one PC share no
socket and no file. The run stops its herdr servers and removes the directory when it ends, also
when it is interrupted; `CHECK_DIR=<path>` keeps it there instead. Only one run with a lane at a
time on a PC: the contract and browser tests are bound by timing, and a second run names the
first and exits (the lock is loopback port 41737, which a run listens on while it runs). One run per checkout: `fast` rewrites the generated types file while it
checks it, and `fast` and the browser lane build into `dist/` (`check run` runs only its command).

A local pass is not CI's: the PC has its own Node (CI pins 22), its own cores and its own system
libraries. The browser lane uses the lockfile's Chromium, which it downloads into Playwright's
cache on first use. `HERDR_TEST_SHARDS=4` runs four integration files at a time, as a way to
look for timing failures; the default is one, as in CI.

The single commands still work on their own:

```bash
bun run typecheck
bun run build
bun run test:unit               # no herdr needed; CI's Fast checks run it
bun test                        # needs herdr installed; creates and removes its own workspaces
bun run test:ui                 # browser regression against isolated test servers
bun scripts/sticky-modifiers-regression.ts # mobile held keys through real legacy/Kitty PTYs
bun scripts/key-bar-customization-demo-regression.ts # mobile key layout, saved combinations and migration on demo fixtures
bun scripts/settings-pages-demo-regression.ts # every Settings page on a 390px and a 320px phone, and Back stepping out of the dialog
bun scripts/chat-browser-qa.ts  # chat lens end to end
bun scripts/output-browser-qa.ts # terminal output flow control end to end
bun scripts/math-browser-qa.ts  # chat math: KaTeX loads with the first expression
bun run test:ssh                # remote-PC integration over SSH
bun scripts/fresh-install-docker.ts [owner/repo] [ref]  # a new user's install in a bare Ubuntu (Docker)
```

`fresh-install-docker.ts` is the check for "does a new user get a working install": a disposable
Ubuntu 24.04 with only curl, git and the distro's Node 18, a normal user, herdr and Bun from their
installers, a headless herdr, then `herdr plugin install` of a pushed ref (default: the current
branch), the start action, `/api/health`, the PTY smoke test on the box's Node, and the startup hook
after a herdr restart. It prints the time each step took. `KEEP=1` leaves the container for a look.

Tests run against a herdr session of their own, `herdr-web-ui-test`. The first run starts a headless `herdr --session herdr-web-ui-test server` and later runs reuse it, so test workspaces never show in the herdr you work in (`scripts/test-herdr.ts`). Stop it with `herdr --session herdr-web-ui-test server stop`. `HERDR_TEST_SESSION` picks another name, and `HERDR_TEST_LIVE=1` runs against `HERDR_SOCKET` or your default session instead.

Browser checks look for Chrome at `/opt/google/chrome/chrome`; set `CHROME_PATH` otherwise. After a herdr upgrade, refresh the generated wire types with `bun run generate:types --refresh` (and `--check` to verify).

For isolated phone viewer and keyboard layout regressions (no herdr session; the demo runner builds the real client locally):

```bash
bun scripts/file-viewer-mobile-regression.ts  # 8 viewport cases × tall/wide images
bun scripts/keyboard-viewport-regression.ts   # keyboard, rotation and measured standalone status inset
bun scripts/keyboard-viewport-demo-regression.ts # original real-app viewport suite on disposable demo fixtures
bun scripts/droplet-demo-regression.ts        # real-app alerts below the header, keyboard and landscape
bun scripts/chat-greeting-demo-regression.ts  # an empty chat's greeting: centred on a desktop, docked on a phone
bun scripts/composer-fit-demo-regression.ts   # one Send/Stop control, pending Send now actions, context/label fit and Chat font sizing
bun scripts/held-rows-demo-regression.ts      # held messages: the fold under an approval card, its button, a row's error
bun scripts/sidebar-activity-demo-regression.ts # Agents order Activity and Quiet opened finishes: blocked pinned, recency, an opened DONE drawn as ready
bun scripts/prompt-dock-demo-regression.ts    # the prompt card docked over the input card: its place, its height on a short phone, the grip, a typed pick
bun scripts/font-swap-demo-regression.ts      # the app's faces arriving late on a slow link: a reader at the end of a chat stays there, a tab strip the user scrolled stays put
```

`FILE_VIEWER_CASE=landscape-notch` selects a viewer case; `FILE_VIEWER_CSS=/path/to/before.css` compares another stylesheet. These checks use Chromium mobile emulation and synthetic safe-area/keyboard geometry; they cannot verify actual iOS Safari keyboard dismissal or notch insets. The existing `bun scripts/file-viewer-regression.ts` separately checks history with an owned herdr pane. The original `scripts/mobile-viewport-regression.ts` exports `checkMobileViewport` for the real-app `bun run test:ui` suite; it also checks the command palette and xterm focus transitions. The demo runners build the real client into a temporary directory, inject the committed fictional-session transport and serve it only on loopback; they do not use a live herdr session or download website media. Run on its own, each builds the client itself (`scripts/demo-build.ts`); the browser lane builds it once and names the directory in `HERDR_DEMO_BUILD`, and each runner copies that instead. They exercise real-app viewport and alert geometry, but not live herdr connectivity.

## README media

`bun run build && bun scripts/readme-media/capture.ts` regenerates the stills and demos in `docs/screenshots/` from a staged, fictional session in its own herdr session (`herdr-web-ui-demo`). Pass `shots` or `video` to redo only one of them. It needs ffmpeg.

- `stage.ts` builds the session: five workspaces under `/tmp/herdr-demo`, curated chats served in place of transcripts, and the hostname rewritten.
- `record.ts` records a walkthrough at 2x (Chrome's screencast, with `--force-device-scale-factor=2`), logging pointer moves, clicks, taps and camera cues as it drives the page.
- `compose.ts` draws every output frame on a canvas: a backdrop, a browser window or a phone, the frame under an eased camera, and a vector cursor with click ripples or touch rings. It writes `demo-*.mp4` (1920×1200 and 1080×1920, 30 fps) and a GIF of each. Stills get the same window or phone on a transparent background.

The MP4s are not committed: GitHub plays a README video only from an upload (`github.com/user-attachments/…`), so drop them into an issue or PR comment and use the link it gives.
The website's page is built from the README's own artifacts: it downloads the README's top video (listed in `scripts/build-site.ts`, `videos`, so a new top video needs its link changed there as well), shows the feature grid's clips linking to their uploads (the same list of links is in `site/index.html` and `site/zh/index.html`), and uses `docs/screenshots/install.png`.
The README's feature grid shows a looping ~7-second cut of each feature video (`docs/media/readme/*.webp`, 800×450, 15 fps), each linking to its upload. Cut one with
`ffmpeg -ss <start> -t <seconds> -i clip.mp4 -vf "fps=15,scale=800:450:force_original_aspect_ratio=increase:flags=lanczos,crop=800:450" -c:v libwebp_anim -loop 0 -quality 72 -compression_level 6 -an out.webp`;
the scale and crop fill 800×450 from any source aspect. Start on a sharp frame, not mid camera move. The top video stays a GitHub upload so it plays at full quality.

The user guide's gallery and the retained banner assets are rendered from the film's stills (below): `bun scripts/readme-media/banner.ts [banner] [og] [look]`
draws `banner.html` in headless Chrome into `docs/media/banner.png` (1920×800), `site/assets/og.png` (1280×640) and
`docs/media/look-{chat,prompt,terminal}.png` (1760×1150), each quantized to 256 colours. `docs/media/chat-loop.gif`
comes from `scripts/film/render.ts loop`.

## The film

The film (`site/media/herdr-web-ui-film.mp4`, 56 s) and chat loop (`site/media/chat-loop.mp4`, with the README's
`docs/media/chat-loop.gif`) are the real client on the demo's fixtures, recorded and composited by `scripts/film/`.
Raw footage and renders go to `_film/` (gitignored); only the outputs under `site/media/`, `site/assets/` and
`docs/media/` are committed. Needs ffmpeg and Chrome at `/usr/bin/google-chrome` (`CHROME_PATH` otherwise).

```bash
bun run build:site                              # the demo the takes are recorded from
bun scripts/film/capture.ts [stills] [rec] [stepped] [R10 R11 … | still names]   # _film/footage/
bun scripts/film/site-assets.ts                 # site/assets/*.webp|jpg|png from the stills
bun scripts/readme-media/banner.ts              # banner, og.png, look-*.png from the stills
bun scripts/film/render.ts film                 # site/media/herdr-web-ui-film.{mp4,jpg}
bun scripts/film/render.ts loop                 # site/media/chat-loop.{mp4,jpg}, docs/media/chat-loop.gif
bun scripts/film/render.ts check                # acceptance frame grabs, sizes, loop seam
```

- `capture.ts` serves `_site/` under `/herdr-web-ui/` and records `demo/app/` (no demo banner) at 2x with `hand.ts`
  (CDP screencast frames with paint times, plus a cue log of every pointer move, click and tap). Film-only staging lives
  here as init scripts, never in `site/demo/`: fixture `mods` (`todo`, `real`, `stream`, `story`, `worked`) change what
  the fixtures say, and `filmHold` holds the demo's own 4.5 s / 2.4 s timers so a turn stays running on camera.
  `_film/footage/INDEX.md` lists every take, its mods and its marks.
- `timeline.ts` is the film shot by shot as data (source ranges from each take's `marks.json`, camera, type);
  `camera.ts` the easing and matrices; `stage.ts` the compositor page that draws one frame; `footage.ts` reads the takes.
- `render.ts` renders frames in parallel Chromes and encodes once. `render.ts report` prints the shot table with the
  maximum magnification (never above 1 source px per output px); `render.ts stills 8 13.6 …` grabs single frames.
- After a re-capture, re-check what was placed by hand on the frames (the header of `render.ts` lists it), then
  re-render. `build-site.ts` fails if a file in `site/media/` is over 4 MB (the film: 24 MB) or one in `site/assets/`
  is over 750 KB.

## Website

<https://herdrweb.dev/> is `site/index.html`, a static page with desktop and phone
demos, a screenshot gallery, supported agents, phone setup and a comparison table. `site/zh/index.html`
is the same page in Simplified Chinese at `/zh/`, linked from the header; a change to one page belongs in
the other. `bun run build:site`
assembles it into `_site/` with icons, the social preview and scaled screenshots from `docs/screenshots/`.
The two demo videos come from local `docs/screenshots/*.mp4` when present, otherwise the README's uploads;
ffmpeg creates their poster frames. Without ffmpeg, the page omits unavailable posters.

For search engines the build also writes `sitemap.xml` (the page only: the demo is `noindex`) and copies
the page's FAQ rows (`<div class="qa">`) into its head as FAQPage structured data, so edit a question in
the page and the data follows. The SoftwareApplication data is written in the page's head by hand.

The build also copies the retained `site/assets/` and `site/media/` files, including the film linked
from the README and its chat loop. These remain available at their existing URLs even though the
homepage uses the desktop and phone demos.
`.github/workflows/pages.yml` installs ffmpeg, runs the same build and deploys it to GitHub Pages on
every push to `main`.

### The browser demo

<https://herdrweb.dev/demo/> is the real client on a fictional session, no server.
`build-site.ts` builds the client a second time with `vite build --base ./` into `_site/demo/app/`,
bundles `site/demo/transport.ts` in front of it and frames it with `site/demo/index.html`. The
transport answers the app's `fetch("/api/…")`, the machines event stream and the `/ws` terminal
socket from `site/demo/fixtures/`: the chats and the Codex approval are the README's
(`site/demo/fixtures.ts`, shared with `scripts/readme-media/stage.ts`), and `machines.json`,
`agents.json`, `commands.json` and the shell pane's `terminal.json` are captured from that staged
session by `bun scripts/demo-fixtures.ts` (needs herdr; it uses the `herdr-web-ui-demo` session and
scrubs the hostname and login). Recapture them after a herdr upgrade changes the snapshot shapes, or
after changing the staged session. Files, images, push and remote PCs are not part of the demo.

## Releasing

1. Open a release PR that bumps `version` in `package.json` and `herdr-plugin.toml`,
   moves the `Unreleased` notes in [CHANGELOG.md](../CHANGELOG.md) under the new version,
   and tells the release in [release-summaries.json](../release-summaries.json) the way a
   game's patch notes do: under the version, for each of `en`, `ko`, `ja` and `zh`, the lists
   `new`, `improved` and `fixed` (a list with nothing to say is left out), each a few lines of
   plain text, 90 characters at most, the same number of lines in every language. It is what
   an install shows before and after the update, with the changelog section folded under it,
   so a line names what changes for the people who use the app and leaves out PR numbers and
   internals. The unit suite and the release workflow fail without all four languages.
   The GitHub release is written from the same files by `scripts/release-notes.ts`: the
   English lists under New features, Improvements and Bug fixes, then the version's whole
   changelog section folded under **Full changelog**.
2. Merge it after CI passes.
3. Run **Actions → Release → Run workflow**, select `main`, and enter `X.Y.Z` without `v`.
   The CLI equivalent is `gh workflow run release.yml --ref main -f version=X.Y.Z`.

The workflow validates metadata, then runs the same unit, integration and browser checks
as PRs against the exact `main` commit selected when the run starts. Only after all checks
pass does it create the tag and GitHub release. A failed validation creates neither.
Do not push release tags by hand: installed updaters read Git tags directly, so a tag is
visible to them even without a GitHub release. Existing tags cannot be reused; fix a
published version with a new patch release. If publishing fails after a tag was created,
verify that tag's commit and repair its GitHub release rather than moving the tag.

Remote-PC runtime bundles are released separately: raise `REMOTE_BUNDLE_VERSION` in `shared/machines.ts` and push a `remote-vN` tag. See [remote PCs](remote-pcs.md).

## Pull requests and CI

Contributors: [CONTRIBUTING.md](../CONTRIBUTING.md) is the short version of this section.

Use short-lived `feat/*`, `fix/*` or `chore/*` branches from `main`. Keep each PR focused
on one change, squash merge it after required checks pass, and delete its remote branch
after merging. Remove local branches/worktrees only when their work is finished.
There is no permanent `develop` branch. Release metadata changes also go through a PR.

The [CI workflow](../.github/workflows/ci.yml) runs on every PR and `main` push:

- **Fast checks**: frozen dependency install, then `bun run check fast`: workflow syntax
  (checksum-pinned actionlint), generated type freshness, typecheck, build, and
  `bun run test:unit`. This suite does not start herdr.
- **Integration and browser**: checksum-pinned herdr 0.9.3, Node 22, then
  `bun run check integration browser`: a build, `bun run test:integration`, and the browser
  scripts of `scripts/ci-browser.sh` with the lockfile's Chromium, on a herdr of the run's own
  ([Checks](#checks)). The two lanes run at the same time (`scripts/ci-lanes.ts`). The
  integration files can run a few at a time, each worker on a herdr session of its own
  (`scripts/ci-tests.ts`); they run one by one (`HERDR_TEST_SHARDS`, default 1 in
  `scripts/check.ts`) until the timing-bound contract tests hold under load.
  Missing herdr fails the run. Its herdr servers are stopped even on failure.
  Integration tests have a 15-second default timeout so their bounded process-startup
  probes can finish; individual tests can still specify a longer timeout.

`scripts/ci-tests.ts` discovers all `.test.ts` files under src/shared/server/scripts.
Files named `*.contract.test.ts`, tests under `server/herdr/` and `server/pty/`, and
`server/updater.test.ts` (which includes real bridge restart/rollback cases) belong
to integration; everything else belongs to unit. Name new live-server tests
`*.contract.test.ts`. Plain `bun test` still runs both suites for local development.

Remote/server/shared/dependency changes also run the existing four-platform bundle and
SSH workflow on PRs; its publishing job only runs for `remote-v*` tags. Website publishing
continues after `main` pushes.

Repository protection should require PRs and both CI checks on `main`, including for
administrators, with branches up to date before merging. Force pushes and branch deletion
are disabled. Human approvals are optional for this maintainer-led project; external
contributions still need maintainer review. CodeRabbit is advisory, not a required check.
Release tags must not be moved or deleted. These GitHub settings are separate from files
in the checkout.

The [CodeRabbit configuration](../.coderabbit.yaml) reviews non-draft PRs, reads the committed
[review guidelines](../.github/REVIEW.md) and the AGENTS.md files,
and focuses on protocol, permissions and terminal lifecycle regressions. Generated output
and media are excluded. Enable the [CodeRabbit GitHub App](https://github.com/apps/coderabbitai)
for this repository to activate it; the YAML alone does not install the app. Reassess
useful findings versus false positives after two weeks. Keep final merge decisions with
the maintainer.

See [Terminal input](terminal-input.md) for input readiness, draft ownership and the mobile
input regression matrix.

## Layout

| Path | Contents |
| --- | --- |
| [`src/`](../src/) | React UI: chat, terminal, composer, sidebar, settings |
| [`server/`](../server/) | API, WebSockets, transcript readers, push, PTY bridge, remote PCs and updater |
| [`shared/`](../shared/) | HTTP/WebSocket contract and generated herdr types |
| [`scripts/`](../scripts/) | Plugin lifecycle, type generation, remote bundles, README media, the film and browser checks |
| [`public/`](../public/) | PWA manifest, service worker and icons |
| [`docs/`](.) | Remote PCs, updates, flow control, chat audit, brand assets and README media (`docs/media/`) |
| [`site/`](../site/) | The website, built by `scripts/build-site.ts` and deployed by GitHub Pages |
| [`DESIGN.md`](../DESIGN.md) | Design tokens and UI conventions |
