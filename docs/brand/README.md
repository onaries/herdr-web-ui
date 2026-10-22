# Project artwork

The Ovis artwork is the sleeping sheep on navy that the native apps and
[ovis.sh](https://ovis.sh) use: `app/assets/icon-only.png` (the app icon),
`app/assets/ovis-sheep.png` (the sheep on transparent) and ovis.sh's link preview
`ovis-site/assets/og-icon.png`. Exports preserve the artwork. `icon-source.png` here is the
earlier ram artwork, still read by `scripts/film/` until the film is made again.

Run `bun scripts/generate-brand.ts` to regenerate the web app's icons, favicon,
Apple touch icon, notification badge and social preview from them. This optional
asset task requires FFmpeg; it is not needed to run the app. Maskable icons
include extra padding for rounded and circular masks. Changed icon files need a
new `?v=` query and service worker cache (`src/conventions.test.ts`, "icon cache").

The [social preview](../../public/social-preview.png) is 1280 × 640 PNG,
under 1 MB. GitHub's repository preview is a separate setting: open
[repository settings](https://github.com/devswha/ovis/settings),
then **Social preview → Edit → Upload an image** and select that file.
See [GitHub's instructions](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview).
