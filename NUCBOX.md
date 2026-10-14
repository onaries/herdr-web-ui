# Nucbox operating branch

This checkout runs the `nucbox` branch of <https://github.com/onaries/herdr-web-ui>.
`origin` is the personal fork; `upstream` is <https://github.com/devswha/herdr-web-ui>.
Native agy and dsh conversations, recent-first transcript pages,
input and paste fixes, and the live compaction indicator are tracked here.

## Patch ownership after 0.4.3

Use upstream implementations for terminal selection and copying, wheel and touch scrolling,
and background-window resize protection. Do not reapply the old fixed-grid or native-height
clamps: they are absent from the operating source. Upstream protects a pane from inactive
windows; it does not impose the old height limit on an active browser window.

Keep the personal agy/dsh transcript readers, recent-first 12-prompt pages,
OmO question save/submit keys, live compaction indicator, stale-cwd image-paste
handling, and Chrome `notranslate` metadata. These are not supplied by the 0.4.3 release.
The MacBook checkout retains only the OmO question-key and `notranslate` patches, with their
tests; it does not need duplicate terminal selection, scrolling, or resize patches.

Use upstream's virtualized chat, recent-tab mount retention and cached newest-page
display. Do not restore the private hidden-chat DOM retention patch; pane retention
and visibility must follow upstream's attachment and resize ownership rules. The
12-prompt newest-page limit remains
separate because it bounds transcript reading and response work, not DOM rendering.
Position restoration applies only when the saved turn is in the newly loaded page;
an older unloaded turn falls back to the latest messages. Expanded work and fetched
outputs survive virtual-row eviction, but reset when the chat itself unmounts.

## Updating

Keep the operating checkout on `nucbox` and `HERDR_WEB_AUTO_UPDATE=0` in the systemd unit.
The WebUI release installer expects `main` and must not replace this custom branch.
Use the persistent-fork updater for a clean checkout. It merges upstream, runs the fast
checks, commits the merge, rebuilds with the final revision and restarts only WebUI:

```sh
update-herdr-web-ui --ref v0.4.5
```

Choose the requested release tag (for example, `v0.4.5`), or omit `--ref` to merge upstream `main`. Review and
preserve pending local work first; the updater refuses a dirty checkout. Resolve conflicts
without discarding personal changes. Do not run the legacy plugin installer or `apply.sh`
over this fork. Push `origin/nucbox` only when explicitly requested. Refresh the browser after
deployment, and check remote bundle compatibility before updating the MacBook separately.

Even a frontend-only commit requires a WebUI service restart after rebuilding. The
supervisor captures its revision at startup, while Vite embeds the build's Git revision.
Serving a newer frontend from an older supervisor makes the update notice persist after
every reload. After deployment, verify that `/api/updates` `current_revision` and
`/api/health` `web_ui.revision` match the commit used for the frontend build. Restart
only `herdr-web-ui.service`, with the user's approval; never restart native agent sessions.

## Local operation

The persistent operating source is `/home/seonwookim/projects/herdr-web-ui-nucbox`, outside
Herdr's replaceable plugin installation directory. The user systemd service
`herdr-web-ui.service` runs this source while preserving the existing plugin configuration
and state directories. Agent sessions are managed separately by Herdr.

The older agy and compaction patch bundles remain recovery copies outside this repository.
Do not apply them over implementations already tracked by this branch. SSH configuration,
auth tokens, private keys, machine profiles, and service state stay outside Git.

On 2026-10-08 the plugin checkout had been replaced after the original local commits were
prepared. The first two commits were recovered intact; the chat/compaction commit was
recovered with the same file changes from its verified staged-source snapshot. The replaced
plugin directory and its pending edits were left untouched.
