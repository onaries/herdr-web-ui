### Added
- **Remote PCs from a Windows connection server**: the web UI running on Windows x64 now
  connects to other PCs with Windows' own OpenSSH and `ssh-agent`, including the machines saved
  in herdr. A key loaded with `ssh-add` signs without a prompt; otherwise the passphrase or
  password is asked once per connection. An unknown host's fingerprint is shown before anything
  authenticates, and a key path such as `C:\Users\you\.ssh\id_ed25519` is accepted. A host whose
  SSH config adds its own port forwards is refused on Windows, with that reason, and a host that
  asks for a password only through keyboard-interactive needs a key in `ssh-agent` there.
