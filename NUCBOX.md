# Nucbox operating branch

This checkout runs the `nucbox` branch of <https://github.com/onaries/herdr-web-ui>.
`origin` is the personal fork; `upstream` is <https://github.com/devswha/herdr-web-ui>.
Native agy and dsh conversations, recent-first transcript pages, retained chat screens,
input and paste fixes, and the live compaction indicator are tracked here.

## Updating

Keep the operating checkout on `nucbox` and `HERDR_WEB_AUTO_UPDATE=0` in the systemd unit.
The WebUI release installer expects `main` and must not replace this custom branch.
Review pending local work before integrating upstream:

```sh
git fetch upstream
git switch nucbox
git merge upstream/main
bun run check fast
CHROME_CDP=http://127.0.0.1:9222 bun scripts/chat-history-browser-qa.ts
systemctl --user restart herdr-web-ui.service
git push origin nucbox
```

Resolve conflicts before building. Do not discard local changes to make a merge pass.
The repository check includes the production build. Refresh the browser after deployment.

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
