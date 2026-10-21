# ovis.sh

The website of Ovis, the phone, desktop and browser client for herdr: the home page, the privacy
policy (`/privacy/`) and the support page (`/support/`) the App Store and Google Play ask for.
It is plain HTML with no build, so edit the files and the next deploy serves them.

- The home page (`index.html`) carries its own styles and scripts. It is English as written;
  Simplified Chinese, Japanese and Korean come from the `#i18n-data` JSON in the same file, keyed
  by the English HTML of each text block, and the visitor picks one in the header (`?lang=zh`,
  `ja` or `ko` opens it directly; the choice is kept in `localStorage`). `/ko/` redirects to
  `/?lang=ko`. Change English text and its entry together, or the block stays English.
- It has a day and a night look (`data-theme` on `<html>`, the visitor's choice or the system
  setting); every screenshot has a `-light` and a `-dark` file, swapped by `data-light` /
  `data-dark`, and the mascot and logo have `-night` versions.
- The privacy, support and 404 pages use `style.css`, in English at the root and Korean under
  `/ko/`.

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
- The screenshots in `assets/demo/` come from the demo build (`bun scripts/demo-build.ts <dir>`),
  never from a real session: English, light and dark theme, desktop at 1440×900 and phone at
  390×844, both at 2× (`chat`: the checkout-api chat, `approve`: the Codex approval, `terminal`:
  the release shell, `plan`: the plan panel, `workspaces`: the phone's workspace list).
  `approve-card-*` is the approval card cut out of the phone shot and `approve-base-*` the same
  shot without it, for the card's arrival in the hero.
- The quotes under "Loved by developers" are public posts on X, linked to each post, with the
  author's avatar saved in `assets/x/`.
- `assets/og-icon.png` is the link preview every page names (1200×630 PNG: the app icon, large, above
  the name, like an app's store page, so it still reads at a phone's card size). Remake it when the hero or the screenshots change.
- The Geist font in `assets/fonts/` is under the SIL Open Font License (`assets/fonts/LICENSE`).
- The icon and logo are the app's (`app/assets/`, `app/web/ovis-logo.png`).
