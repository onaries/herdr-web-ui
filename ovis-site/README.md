# ovis.sh

The website of Ovis, the iPhone and Android app for herdr web UI: the home page, the privacy
policy (`/privacy/`) and the support page (`/support/`) the App Store and Google Play ask for, in
English at the root and Korean under `/ko/`. It is plain HTML and one stylesheet: there is no
build, so edit the files and the next deploy serves them.

## Deploy

Cloudflare Pages serves it, connected to this repository:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Framework preset | None |
| Build command | (empty) |
| Build output directory | `ovis-site` |
| Root directory | (empty) |
| Build watch paths, include | `ovis-site/*` |
| Custom domain | `ovis.sh` |

A push to `main` that touches `ovis-site/` deploys the site, and a pull request touching it gets a
preview address. Cloudflare serves `404.html` for a missing page and `/privacy` at `/privacy/`.

## Keep in step with the app

- The privacy policy states what the app keeps (the saved PC addresses and each PC's sign-in
  cookie), that the camera only reads the pairing QR code, and what herdr web UI's anonymous usage
  counts hold (docs/guide.md, "Anonymous usage counts"). Change it, and its date, in both
  languages when any of those changes, before the release that changes them.
- The support page names app labels (**Scan QR code**, **Forget**, **Change PC**) and web UI
  settings (**Settings → Phone & devices**, **Settings → About**); keep them matching the app.
- The screenshots come from the demo build (`bun scripts/demo-build.ts <dir>`) at 390×844, in
  each language, never from a real session.
- The icon and logo are the app's (`app/assets/`, `app/web/ovis-logo.png`).
