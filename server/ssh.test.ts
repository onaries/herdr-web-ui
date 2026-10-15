import { afterEach, describe, expect, it } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SshConnection } from "./ssh.ts";

// The direct mode Windows uses (its OpenSSH has no connection sharing), run here against a
// stand-in ssh. Windows itself runs it against real hosts; this sh stand-in needs a POSIX shell.
const FAKE_SSH = String.raw`#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_DIR/calls"
kh=""; batch=""; learn=""; config=""; tunnel=""; forward=""; prev=""; last=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then
    case "$a" in
      UserKnownHostsFile=*) [ -z "$kh" ] && kh="${"${a#UserKnownHostsFile=}"}" ;;
      BatchMode=*) [ -z "$batch" ] && batch="${"${a#BatchMode=}"}" ;;
      PreferredAuthentications=none) learn=1 ;;
    esac
  fi
  [ "$prev" = "-L" ] && forward="$a"
  [ "$a" = "-G" ] && config=1
  [ "$a" = "-N" ] && tunnel=1
  prev="$a"; last="$a"
done
if [ -n "$config" ]; then
  echo "hostname pc.example"
  [ -n "$FAKE_CONFIG_FORWARD" ] && echo "localforward 8080 127.0.0.1:80"
  exit 0
fi
known=$(printf '%s' "$kh" | sed "s/^'\([^']*\)'.*/\1/")
if [ -n "$learn" ]; then
  printf '%s\n' "$FAKE_HOSTKEY_LINE" >> "$known"
  echo "pc@pc.example: Permission denied (publickey)." >&2; exit 255
fi
if [ -n "$FAKE_HOSTKEY_LINE" ] && ! grep -qF "$FAKE_HOSTKEY_LINE" "$known" 2>/dev/null; then
  echo "No ED25519 host key is known for pc.example and you have requested strict checking." >&2
  echo "Host key verification failed." >&2; exit 255
fi
if [ -n "$FAKE_INTRUDER" ]; then
  HERDR_ASKPASS_TOKEN=forged "$SSH_ASKPASS" "Enter passphrase for key 'k': " > "$FAKE_DIR/intruder" 2>/dev/null
  echo $? > "$FAKE_DIR/intruder.code"
fi
if [ -n "$FAKE_PASSPHRASE" ]; then
  if [ "$batch" = "yes" ]; then echo "pc@pc.example: Permission denied (publickey)." >&2; exit 255; fi
  answer=$("$SSH_ASKPASS" "${"${FAKE_PROMPT:-Enter passphrase for key 'k': }"}") || { echo "pc@pc.example: Permission denied (publickey)." >&2; exit 255; }
  [ "$answer" = "$FAKE_PASSPHRASE" ] || { echo "pc@pc.example: Permission denied (publickey)." >&2; exit 255; }
fi
if [ -n "$tunnel" ]; then
  [ -z "$forward" ] && exec sleep 30
  port=$(printf '%s' "$forward" | cut -d: -f2)
  exec "$FAKE_BUN" -e "let opened = 0; Bun.listen({ hostname: '127.0.0.1', port: $port, socket: { open() { if (++opened === Number(process.env.FAKE_TUNNEL_ENDS_AT)) process.exit(0); }, data() {} } });"
fi
[ "$last" = "exit" ] && exit 0
echo ran
`;

// `ssh-keygen -l -f <known_hosts>` for the ed25519 lines the stand-in ssh learns. CI's runner
// image has no OpenSSH, so the real one cannot be relied on.
const FAKE_SSH_KEYGEN = String.raw`#!/bin/sh
for file; do :; done
exec "$FAKE_BUN" -e '
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
for (const line of readFileSync(process.argv.at(-1), "utf8").trim().split("\n")) {
  const [host, , key] = line.split(" ");
  console.log("256 SHA256:" + createHash("sha256").update(Buffer.from(key, "base64")).digest("base64").replace(/=+$/, "") + " " + host + " (ED25519)");
}' "$file"
`;

const FAKE_KEYS = ["FAKE_DIR", "FAKE_BUN", "FAKE_PASSPHRASE", "FAKE_PROMPT", "FAKE_HOSTKEY_LINE", "FAKE_INTRUDER", "FAKE_CONFIG_FORWARD", "FAKE_TUNNEL_ENDS_AT"];

describe.skipIf(process.platform === "win32")("SSH without connection sharing", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

  function fixture(env: Record<string, string> = {}) {
    const root = mkdtempSync(join(tmpdir(), "herdr-ssh-direct-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "ssh"), FAKE_SSH);
    chmodSync(join(bin, "ssh"), 0o755);
    writeFileSync(join(bin, "ssh-keygen"), FAKE_SSH_KEYGEN);
    chmodSync(join(bin, "ssh-keygen"), 0o755);
    const saved = Object.fromEntries(["PATH", ...FAKE_KEYS].map((key) => [key, process.env[key]]));
    process.env["PATH"] = `${bin}:${saved["PATH"]}`;
    Object.assign(process.env, { FAKE_DIR: root, FAKE_BUN: process.execPath }, env);
    const state = join(root, "state");
    const ssh = new SshConnection({ destination: "pc" }, state, undefined, false, false);
    const prompts: { prompt: string; hostKey: boolean }[] = [];
    cleanups.push(() => {
      ssh.close();
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      rmSync(root, { recursive: true, force: true });
    });
    const calls = () => readFileSync(join(root, "calls"), "utf8").trim().split("\n");
    const ask = (answer: string) => async (prompt: string, hostKey: boolean) => { prompts.push({ prompt, hostKey }); return answer; };
    return { root, state, ssh, prompts, calls, ask };
  }

  it("lets the agent sign without a prompt and keeps every command non-interactive", async () => {
    const { ssh, prompts, calls, ask } = fixture();
    await ssh.start(ask("unused"));
    expect(await ssh.run("true")).toBe("ran\n");
    expect(prompts).toEqual([]);
    expect(ssh.usedSecret).toBe(false);
    const run = calls().find((line) => line.endsWith("sh -c 'true'"))!;
    expect(run).toContain("BatchMode=yes");
    expect(run).toContain("StrictHostKeyChecking=yes");
    expect(ssh.connected()).toBe(true);
  });

  it("asks for a passphrase once and answers it to the commands after connecting", async () => {
    const { ssh, prompts, calls, ask } = fixture({ FAKE_PASSPHRASE: "secret" });
    await ssh.start(ask("secret"));
    expect(await ssh.run("true")).toBe("ran\n");
    expect(await ssh.run("true")).toBe("ran\n");
    expect(prompts).toEqual([{ prompt: "Enter passphrase for key 'k': ", hostKey: false }]);
    expect(ssh.usedSecret).toBe(true);
    expect(calls().filter((line) => line.endsWith("sh -c 'true'")).every((line) => line.includes("BatchMode=no"))).toBe(true);
    // a keyboard-interactive prompt is the server's text, and cmd would parse it as a command line
    expect(calls().filter((line) => !line.includes("PreferredAuthentications=none") && !line.includes(" -G ")).every((line) => line.includes("KbdInteractiveAuthentication=no"))).toBe(true);
  });

  it("refuses a prompt it was not asked while connecting, without asking the user", async () => {
    const { ssh, prompts, ask } = fixture({ FAKE_PASSPHRASE: "secret" });
    await ssh.start(ask("secret"));
    process.env["FAKE_PROMPT"] = "pc@pc.example's password: ";
    await expect(ssh.run("true")).rejects.toThrow("Permission denied");
    expect(prompts).toHaveLength(1);
  });

  it("never replays an answer that did not authenticate", async () => {
    const { ssh, ask } = fixture({ FAKE_PASSPHRASE: "secret" });
    await expect(ssh.start(ask("wrong"))).rejects.toThrow("Permission denied");
  });

  it("answers no helper that lacks this connection's token", async () => {
    const { root, ssh, prompts, ask } = fixture({ FAKE_PASSPHRASE: "secret", FAKE_INTRUDER: "1" });
    await ssh.start(ask("secret"));
    expect(readFileSync(join(root, "intruder"), "utf8")).toBe("");
    expect(readFileSync(join(root, "intruder.code"), "utf8").trim()).not.toBe("0");
    expect(prompts).toHaveLength(1);
  });

  describe("an unknown host", () => {
    function hostKey(): { line: string; fingerprint: string } {
      const raw = Buffer.from(generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x!, "base64url");
      const field = (bytes: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, bytes.length]), bytes]);
      const blob = Buffer.concat([field(Buffer.from("ssh-ed25519")), field(raw)]);
      const fingerprint = "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
      return { line: `pc.example ssh-ed25519 ${blob.toString("base64")}`, fingerprint };
    }

    it("shows the fingerprint before any authenticating connection and trusts it on yes", async () => {
      const { state, ssh, prompts, calls, ask } = fixture();
      const key = hostKey();
      process.env["FAKE_HOSTKEY_LINE"] = key.line;
      await ssh.start(ask("yes"));
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.hostKey).toBe(true);
      expect(prompts[0]!.prompt).toContain(`ED25519 key fingerprint is ${key.fingerprint}.`);
      expect(readFileSync(join(state, "known_hosts"), "utf8")).toContain(key.line);
      // the learning connection offered no authentication at all
      expect(calls().find((line) => line.includes("PreferredAuthentications=none"))).toContain("IdentityAgent=none");
    });

    it("trusts nothing on no", async () => {
      const { state, ssh, ask } = fixture();
      process.env["FAKE_HOSTKEY_LINE"] = hostKey().line;
      await expect(ssh.start(ask("no"))).rejects.toThrow("Host key verification failed.");
      expect(readFileSync(join(state, "known_hosts"), "utf8")).toBe("");
    });

    it("is not learned without someone to ask", async () => {
      const { root, ssh } = fixture();
      process.env["FAKE_HOSTKEY_LINE"] = hostKey().line;
      await expect(ssh.start()).rejects.toThrow("Host key verification failed.");
      expect(existsSync(join(root, "calls")) && readFileSync(join(root, "calls"), "utf8").includes("PreferredAuthentications=none")).toBe(false);
    });
  });

  describe("forwards", () => {
    it("opens the loopback port, and its ending ends the connection", async () => {
      // the tunnel ends at its second connection: the first is forward()'s own readiness check
      const { ssh, ask } = fixture({ FAKE_TUNNEL_ENDS_AT: "2" });
      await ssh.start(ask("unused"));
      const ended = Promise.withResolvers<void>();
      ssh.onExit = () => ended.resolve();
      const free = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
      const port = free.port;
      free.stop(true);
      await ssh.forward(port, 7317);
      const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
      socket.end();
      await ended.promise;
      expect(ssh.connected()).toBe(false);
    });

    it("refuses a host whose SSH config adds forwards of its own", async () => {
      const { ssh, ask } = fixture({ FAKE_CONFIG_FORWARD: "1" });
      await ssh.start(ask("unused"));
      await expect(ssh.forward(40_000, 7317)).rejects.toThrow("LocalForward, RemoteForward or DynamicForward");
    });
  });
});
