# Ovis for Mac

The one-click setup for a Mac, downloaded from https://ovis.sh as `Ovis.dmg`. The phone apps
need the Ovis server running on the computer; this app sets that up without a terminal and shows the
QR code the phone app scans.

It is a small SwiftUI app with no code of its own for installing: everything goes through what a
terminal user runs, so the two never drift apart.

| Button | What runs |
| --- | --- |
| **Install** | `install.sh`, downloaded fresh from https://ovis.sh/install.sh, with `OVIS_NO_OPEN=1` and an empty stdin. Then a LaunchAgent, `~/Library/LaunchAgents/sh.ovis.herdr-server.plist`, runs `herdr server` at login. |
| Status (on open) | `herdr plugin list --json` finds the plugin, `scripts/plugin.ts status` gives its address, and `GET /api/access` gives the phone address, drawn as a QR code. |
| **Make the phone address** | `scripts/plugin.ts phone`, the installer's Tailscale step. |
| **Restart** / **Start** | The plugin's `stop` and `start` actions, or the LaunchAgent when herdr is not running. |
| **Remove** | The guide's Uninstall steps (`stop`, `herdr plugin uninstall`, `tailscale serve … off`), then the LaunchAgent is disabled and deleted. |

Why a LaunchAgent: herdr runs the app from its startup hook, and a headless `herdr server` runs
startup hooks like the TUI's server does. A user who never opens a terminal still gets the app,
and a later `herdr` in a terminal attaches to that same server.

What it never does:
- It never boots out a loaded LaunchAgent, and Remove never stops herdr. That herdr may hold the
  user's agents, and stopping it would end them.
- It installs nothing system-wide and asks for no administrator password. install.sh installs for
  the user only.
- It is not in the Mac App Store: the App Store sandbox cannot install herdr, Bun or Node.

## Build

On a Mac with Xcode (the maintainer's test Mac, `ssh eamac`):

```sh
app/mac/build.sh                     # ad hoc signed, for a local try
OVIS_SIGN_IDENTITY="Developer ID Application: … (5987KT43TJ)" \
OVIS_NOTARY_KEY=~/.appstoreconnect/private_keys/AuthKey_<id>.p8 \
OVIS_NOTARY_KEY_ID=<id> OVIS_NOTARY_ISSUER=<issuer> \
app/mac/build.sh                     # signed, notarized and stapled, for ovis.sh
```

The output is `app/mac/build/Ovis.app` and `app/mac/build/Ovis.dmg`, a universal (arm64 and x86_64)
build for macOS 13 or newer. Only the Apple account holder can create a Developer ID Application
certificate; the API key can notarize with it.

To try it on a Mac without touching its user's herdr, give it an empty home. Foundation reads
`CFFIXED_USER_HOME`, and the LaunchAgent passes `HOME` on to herdr:

```sh
h=$(mktemp -d /tmp/ovish.XXXX)
open -n --env CFFIXED_USER_HOME="$h" --env HOME="$h" app/mac/build/Ovis.app
```

The LaunchAgent's label is the same for every home, so remove it after such a test:
`launchctl bootout gui/$(id -u)/sh.ovis.herdr-server`, then `HOME="$h" herdr server stop`.
