# Installing herdr web ui (guide for coding agents)

Follow these steps in order to install herdr web ui for a user. Run each command and check its output
before moving on. Every step says what success looks like. Stop and ask the user whenever a step says
**Ask**.

herdr web ui is a browser and phone client for [herdr](https://github.com/herdrdev/herdr). It adds a
web server on port `7317` and never replaces herdr, its sessions or the user's own terminal.

## Rules

- Bind to `127.0.0.1` (the default) unless the user asks for remote access. Anyone who can reach an
  ungated server can type into the user's terminals. Never bind to `0.0.0.0` or a LAN address, or
  put it behind a proxy other people can reach, without a token (`HERDR_WEB_TOKEN`). A `tailscale
  serve` address may go without one only when the user confirms every device in their tailnet is
  their own.
- Never print, log or commit the token. Write it only to the config file named below and tell the
  user where it is.
- Do not install herdr, Bun or Node yourself unless the user agrees. Say which one is missing and how
  to install it.
- Do not stop or restart the user's herdr server (`herdr server stop`). Restarting herdr web ui is fine.

## 1. Check prerequisites

```bash
bun --version        # need 1.4 or newer
node --version       # Linux/macOS only: need v18 or newer for the terminal-attach sidecar
herdr --version      # need 0.9.0 or newer
herdr status server  # the herdr server must be running
git --version
```

- A missing tool: **Ask** the user before installing it. Bun: `curl -fsSL https://bun.sh/install | bash`.
  herdr: <https://herdr.dev>. Node: the user's usual manager (nvm, Homebrew, distro packages).
- herdr not running: ask the user to start `herdr` in a terminal, then check again.
- Supported platforms: Linux x64 and arm64, macOS, Windows x64. Windows uses the [screen mirror](docs/remote-pcs.md#windows-pcs), so Node is not needed there. No compiler or Python is needed: the terminal
  addon is prebuilt for these platforms. Other platforms (Alpine, 32-bit ARM) have no build.

## 2. Choose the install method

| Method | When | Updates |
| --- | --- | --- |
| **A. herdr plugin** (default) | The user wants it to start with herdr | In-app: Settings → About |
| **B. Source checkout** | The user wants to develop it, or asks for a clone | In-app, while the checkout stays on a clean `main` |
| **C. One-line installer** | The user agrees to install what is missing (herdr, Bun, Node) and to let Tailscale serve the app | In-app, like A |

Use A unless the user says otherwise. C is A plus the prerequisites and step 5 in one command,
`curl -fsSL https://herdrweb.dev/install.sh | sh`: it installs herdr, Bun and
Node 22 for the user only (no sudo) when they are missing, installs the plugin, starts it when herdr
runs, and, when Tailscale runs on the PC, serves the app to the tailnet (`tailscale serve`) and
prints the address as a QR code. It changes the user's Tailscale configuration, so it needs the
same **Ask** as step 5. Running it again keeps what is there. On a first install it prints a link
for a GitHub star, unless the account gh is signed in to has starred the repository already. It
asks whether to give one only at a terminal, and goes on by itself after 20 seconds: do not answer
the question, and do not star the repository for the user.

On Windows x64, use `irm https://herdrweb.dev/install.ps1 | iex` in PowerShell.
It requires Git for Windows and installs missing herdr and Bun for the user, without Node or WSL.
It starts the plugin when herdr runs. Phone access stays optional: use the **Phone setup** action.
`HERDR_WEB_UI_REF` selects a branch or tag for testing; otherwise it installs the latest release.

## 3A. Install as a herdr plugin

```bash
herdr plugin install devswha/herdr-web-ui --yes
```

herdr clones the repository, runs `bun install` and `bun run build`, then registers the plugin. This
takes about a minute.

- Success: the command exits 0 and `herdr plugin list` shows `devswha.herdr-web-ui`.
- The first build step is a check that prints, in one line, what is missing (`bun`, `node`, or a
  version too old) and how to fix it. `bun` or `node` not found means herdr runs build commands
  with **its own** environment: make sure they are on the `PATH` of the shell that started herdr
  (Bun installs to `~/.bun/bin`), ask the user to restart herdr from that shell, then retry.
- On Windows, the plugin launcher reads the current user PATH and Bun's user-local directory,
  so installing Bun while herdr is running does not require restarting herdr.
- "installing over a locally linked plugin is refused": run `herdr plugin unlink devswha.herdr-web-ui`
  first.

Start it now. Otherwise it starts the next time herdr starts:

```bash
herdr plugin action invoke devswha.herdr-web-ui.start
```

On Windows, the start and stop action IDs are `devswha.herdr-web-ui.start-windows` and
`devswha.herdr-web-ui.stop-windows`. The menu titles are the same on every platform.

The command only queues the action and prints herdr's JSON acknowledgement; the action's own output
(`herdr web ui listening at http://127.0.0.1:7317`, and possibly `no token set: ...`, expected for a
local-only install) goes to the plugin log (`herdr plugin log list`). Check it with step 4.

Plugin settings do **not** come from the user's shell. They go in an `env` file (no dot):

```bash
CONFIG_DIR="$(herdr plugin config-dir devswha.herdr-web-ui)"
echo "$CONFIG_DIR/env"
```

The file holds `KEY=value` lines. A plugin checkout from 0.3.25 on also reads `.env` there (the name
herdr's plugin docs use), and `.env` wins where both set a key. An older checkout reads only `env`,
and in-app updates do not replace the checkout: reinstall the plugin (see [Update](#update)) before
relying on `.env`. `bun "$(ls -d ~/.config/herdr/plugins/github/devswha.herdr-web-ui-* | head -1)/scripts/plugin.ts" status`
prints the files it read. After editing, restart the plugin:

```bash
herdr plugin action invoke devswha.herdr-web-ui.stop
herdr plugin action invoke devswha.herdr-web-ui.start
```

## 3B. Install from source

```bash
git clone https://github.com/devswha/herdr-web-ui.git
cd herdr-web-ui
bun install
bun run start
```

`bun run start` runs in the foreground. Start it in a separate herdr pane, or under the user's
service manager, so it keeps running. Settings are environment variables on that command.
`bun run server` and `bun run dev` are development commands and do not update themselves.

## 4. Verify

```bash
curl -s http://127.0.0.1:7317/api/health
```

Success is JSON with `"ok":true` and a `herdr` object, for example
`{"ok":true,"herdr":{"version":"0.9.0","protocol":...},"auth":{"required":false,...},...}`.

- Connection refused: the server is not running. For the plugin, run the `status` action. Command
  logs are listed by `herdr plugin log list`; the server's own log is `server.log` in the plugin's
  state directory. Port `7317` in use: set `PORT` (see [Configuration](#configuration)) and restart.
- An error mentioning the herdr socket: herdr is not running, or it uses a named session. For a
  named session, set `HERDR_SOCKET=~/.config/herdr/sessions/<name>/herdr.sock`. The plugin follows
  herdr's session automatically.

Tell the user to open <http://127.0.0.1:7317>.

## 5. Optional: phone or remote access

**Ask** the user first. This exposes their terminals over the network. Then serve it over HTTPS.
Without HTTPS, a phone can view the app but cannot install it or receive alerts. With Tailscale:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:7317
```

Or run the one-line installer (method C) again, which installs nothing when the app is there, or
`bun scripts/plugin.ts phone` from a source checkout: it runs that command on the first
free HTTPS port when Tailscale runs and does not serve the app yet, says how to undo it, and prints the
address as a QR code. **Settings → Phone & devices** in the app shows this step's state: the address that already works as a QR
code, or the exact command still to run. Who gets in:

- The user's own Tailscale devices get in as the user: `tailscale serve` states the login, and the
  server compares it with this PC's. Nothing to configure. Other people's logins are refused, and
  tagged devices (no person's login) need pairing. If the user's own phone is asked to pair anyway,
  `HERDR_WEB_TAILSCALE_SERVE_ONLY=1` lets it in without a code on a tailnet one login owns
  ([Access and safety](docs/guide.md#access-and-safety)).
- Any other device (someone else's, or a LAN or public address) is paired: **Settings → Phone & devices**
  on the PC shows a six-digit code and a QR code; the device enters it once. On a headless PC with
  no browser, `bun "$(ls -d ~/.config/herdr/plugins/github/devswha.herdr-web-ui-* | head -1)/scripts/plugin.ts" pair`
  prints the code in the terminal. Do this with the user present; never read a code aloud into a log.
- A token (`HERDR_WEB_TOKEN`) is for scripts and proxies. Only when the user asks for one, create it
  without printing it. For the plugin:

   ```bash
   CONFIG_ENV="$(herdr plugin config-dir devswha.herdr-web-ui)/env"
   touch "$CONFIG_ENV" && chmod 600 "$CONFIG_ENV"
   printf 'HERDR_WEB_TOKEN=%s\n' "$(openssl rand -hex 32)" >> "$CONFIG_ENV"
   ```

   For a source install, write the same line to a file only the user can read (for example
   `~/.config/herdr-web-ui/token.env`, mode `600`) and start with
   `env $(cat ~/.config/herdr-web-ui/token.env) bun run start`. Restart herdr web ui either way.

Tell the user the HTTPS address. Until a device is paired, and with no token set, a LAN or proxied
address is open to anyone who reaches it, as before; the server warns on startup. A token sent over
plain `http://` is readable by anyone on the network path: prefer HTTPS (Tailscale or a
TLS-terminating proxy) for any address others can reach.

Other PCs over SSH are added from the web UI (Settings → Remote PCs → **Add PC**), not by an install step here.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `7317` | HTTP and WebSocket port |
| `HERDR_WEB_TOKEN` | unset | Token for scripts and proxies. Once set, every client that is not a paired device or the user's own Tailscale login needs it, this PC included |
| `HERDR_SOCKET` | `~/.config/herdr/herdr.sock` | herdr socket (source installs; the plugin follows herdr) |
| `HERDR_WEB_AUTO_UPDATE` | `0` | `1` installs new versions automatically |
| `HERDR_WEB_STATE_DIR` | `~/.config/herdr-web-ui` | Push keys, device subscriptions, PC registrations, update builds. Keep it across reinstalls. |

The [user guide](docs/guide.md#configuration) lists the rest.

## Update

- Settings → **About** → **Update and restart** when a new release (`vX.Y.Z`) is out. It works for
  both install methods. The new
  version is built separately and the app restarts only if the build and health check pass.
- Plugin alternative: `herdr plugin install devswha/herdr-web-ui --yes` again. It replaces the
  checkout; restart the plugin afterwards.
- Source alternative: `git pull` on `main`, then restart `bun run start`. The in-app updater only
  offers published releases (`vX.Y.Z` tags); `main` can be ahead of the latest release.

## Uninstall

```bash
herdr plugin action invoke devswha.herdr-web-ui.stop
herdr plugin uninstall devswha.herdr-web-ui
```

Uninstall removes herdr's managed checkout. It does not touch `~/.config/herdr-web-ui` (push
subscriptions, saved PCs, update builds). Check whether the plugin config directory (it holds the
token) is still there. Delete either one only if the user asks.
