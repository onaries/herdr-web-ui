import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ptyHost, RUST_SIDECAR_BUILD, rustSidecar } from "./host.ts";
import { PtySession, type PtySessionOptions } from "./session.ts";

/** the Rust host these tests run: OVIS_PTY_SIDECAR_BIN, else the release build */
const RUST_HOST = rustSidecar({ ...process.env, OVIS_PTY_SIDECAR: "rust" });
const built = RUST_HOST !== null;
const LIMIT_MS = 10_000;

describe("ptyHost", () => {
  it("runs the Node sidecar unless OVIS_PTY_SIDECAR=rust asks for the Rust one", () => {
    expect(ptyHost("pty-host.mjs", {})).toEqual(["node", "pty-host.mjs"]);
    expect(ptyHost("pty-host.mjs", { OVIS_PTY_SIDECAR: "node" })).toEqual(["node", "pty-host.mjs"]);
  });

  it("falls back to the Node sidecar when the Rust binary is missing, saying so at most once", () => {
    const said = spyOn(console, "error").mockImplementation(() => {});
    try {
      const env = { OVIS_PTY_SIDECAR: "rust", OVIS_PTY_SIDECAR_BIN: join(tmpdir(), `ovis-no-pty-sidecar-${crypto.randomUUID()}`) };
      expect(ptyHost("pty-host.mjs", env)).toEqual(["node", "pty-host.mjs"]);
      expect(rustSidecar(env)).toBeNull();
      expect(said.mock.calls.length).toBeLessThanOrEqual(1);
    } finally { said.mockRestore(); }
  });

  it.skipIf(!existsSync(RUST_SIDECAR_BUILD))("runs the Rust build, or OVIS_PTY_SIDECAR_BIN, when asked", () => {
    expect(ptyHost("pty-host.mjs", { OVIS_PTY_SIDECAR: "rust" })).toEqual([RUST_SIDECAR_BUILD]);
    expect(rustSidecar({ OVIS_PTY_SIDECAR: "rust", OVIS_PTY_SIDECAR_BIN: RUST_SIDECAR_BUILD })).toBe(RUST_SIDECAR_BUILD);
  });
});

interface Run {
  session: PtySession;
  output: () => string;
  until: (label: string, check: (output: string) => boolean) => Promise<void>;
  /** onExit's code; a killed session never reports one */
  exited: Promise<number | null>;
}

function run(command: string, args: string[], extra: Partial<PtySessionOptions> = {}): Run {
  let output = "";
  const waiters = new Set<() => void>();
  let reportExit!: (code: number | null) => void;
  const exited = new Promise<number | null>((resolve) => { reportExit = resolve; });
  const session = new PtySession({
    command, args, cols: 80, rows: 24, ...extra,
    onData: (data) => {
      output += data;
      for (const waiter of [...waiters]) waiter();
    },
    onExit: (code) => reportExit(code),
  });
  const until = (label: string, check: (output: string) => boolean) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(test);
      reject(new Error(`no ${label} in ${LIMIT_MS} ms: ${JSON.stringify(output.slice(-200))}`));
    }, LIMIT_MS);
    const test = () => {
      if (!check(output)) return;
      clearTimeout(timer);
      waiters.delete(test);
      resolve();
    };
    waiters.add(test);
    test();
  });
  return { session, output: () => output, until, exited };
}

/** Resolves once `path` exists: the command's own word that it got that far, whatever the pty carried. */
async function appears(path: string): Promise<void> {
  const watcher = watch(dirname(path));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${basename(path)} never appeared`)), LIMIT_MS);
      const check = () => {
        if (!existsSync(path)) return;
        clearTimeout(timer);
        resolve();
      };
      watcher.on("change", check);
      check();
    });
  } finally { watcher.close(); }
}

/** A `sleep` whose arguments no other process has: the mark of one test's process group. */
const sleepTag = () => `sleep ${5000 + Math.floor(Math.random() * 4000)}.${String(Math.random()).slice(2, 10)}`;

/** Whether every process whose command line holds `tag` is gone within 3 s (a SIGKILLed one takes a moment). */
async function gone(tag: string): Promise<boolean> {
  for (const deadline = Date.now() + 3000; ;) {
    if (Bun.spawnSync(["pgrep", "-f", tag]).stdout.length === 0) return true;
    if (Date.now() > deadline) return false;
    await Bun.sleep(25);
  }
}

/** A command in a process group of its own whose members ignore SIGHUP: a hangup alone never ends it. */
const STUBBORN_GROUP = (tag: string, then: string) => ["-c", `trap '' HUP; ${tag} & printf READY; ${then}`];

/** The same checks on each host: the Rust one has to behave as the Node one does. */
function parity(host: "node" | "rust") {
  describe.skipIf(host === "rust" && !built)(`PtySession on the ${host} PTY host`, () => {
    const previous = process.env["OVIS_PTY_SIDECAR"];
    beforeAll(() => {
      if (host === "rust") process.env["OVIS_PTY_SIDECAR"] = "rust";
      else delete process.env["OVIS_PTY_SIDECAR"];
    });
    afterAll(() => {
      if (previous === undefined) delete process.env["OVIS_PTY_SIDECAR"];
      else process.env["OVIS_PTY_SIDECAR"] = previous;
    });

    it("starts that host and hands the command its environment without the bridge token", async () => {
      const token = `ovis-host-token-fixture-${crypto.randomUUID()}`;
      const kept = process.env["OVIS_TOKEN"];
      process.env["OVIS_TOKEN"] = token;
      const spawn = spyOn(Bun, "spawn");
      let started: Run | undefined;
      try {
        started = run("sh", ["-c", 'printf "[%s|%s|%s|%s]" "$HERDR_SOCKET_PATH" "$TERM" "${OVIS_TOKEN-unset}" "${HERDR_WEB_TOKEN-unset}"'], {
          env: { HERDR_SOCKET_PATH: "/tmp/ovis-host-parity.sock", HERDR_WEB_TOKEN: token },
        });
        expect(await started.exited).toBe(0);
        const argv = (spawn.mock.calls[0] as unknown as [string[]])[0];
        expect(argv[0]).toBe(host === "rust" ? RUST_HOST ?? "" : "node");
        expect(started.output()).toContain("[/tmp/ovis-host-parity.sock|xterm-256color|unset|unset]");
        // compared as a boolean so a failure never prints the token
        expect(started.output().includes(token)).toBe(false);
      } finally {
        started?.session.kill();
        spawn.mockRestore();
        if (kept === undefined) delete process.env["OVIS_TOKEN"];
        else process.env["OVIS_TOKEN"] = kept;
      }
    }, 15_000);

    it("delivers split UTF-8 and the entire final burst before reporting the exit code", async () => {
      const expected = "한글🙂\u001b[31m끝\u001b[0m".repeat(100_000);
      const burst = run("node", ["-e", `
        const data = Buffer.from("한글🙂\\x1b[31m끝\\x1b[0m".repeat(100000));
        process.stdout.write(data.subarray(0, 1));
        setTimeout(() => process.stdout.write(data.subarray(1), () => process.exit(7)), 10);
      `]);
      try {
        expect(await burst.exited).toBe(7);
        expect(burst.output() === expected).toBe(true);
      } finally { burst.session.kill(); }
    }, 15_000);

    it.skipIf(process.platform === "win32")("signals SIGWINCH to the command without changing its size", async () => {
      const winch = run("node", ["-e", `
        process.on("SIGWINCH", () => process.stdout.write("WINCH " + process.stdout.columns + "x" + process.stdout.rows, () => process.exit(0)));
        process.stdout.write("READY");
        setInterval(() => {}, 1000);
      `], { cols: 40, rows: 5 });
      try {
        await winch.until("READY", (output) => output.includes("READY"));
        winch.session.winch();
        expect(await winch.exited).toBe(0);
        expect(winch.output()).toContain("WINCH 40x5");
      } finally { winch.session.kill(); }
    }, 15_000);

    it.skipIf(process.platform === "win32")("resizes the pty, and the command hears it", async () => {
      // process.stdout first: its own SIGWINCH listener, which refreshes the size, has to run before ours
      const resized = run("node", ["-e", `
        const out = process.stdout;
        process.on("SIGWINCH", () => out.write("WINCH " + out.columns + "x" + out.rows, () => process.exit(0)));
        out.write("READY");
        setInterval(() => {}, 1000);
      `], { cols: 40, rows: 5 });
      try {
        await resized.until("READY", (output) => output.includes("READY"));
        resized.session.resize(60, 10);
        expect(await resized.exited).toBe(0);
        expect(resized.output()).toContain("WINCH 60x10");
      } finally { resized.session.kill(); }
    }, 15_000);

    it("holds output while paused with input live, and delivers it all on resume", async () => {
      const dir = mkdtempSync(join(tmpdir(), "ovis-pty-pause-"));
      const wrote = join(dir, "wrote");
      const interrupted = join(dir, "interrupted");
      const held = "B".repeat(1000);
      const paused = run("node", ["-e", `
        const fs = require("fs");
        process.stdin.setRawMode(true);
        process.stdin.on("data", (data) => {
          const text = data.toString();
          if (text.includes("\\x03")) fs.writeFileSync(${JSON.stringify(interrupted)}, "");
          if (text.includes("go")) process.stdout.write("B".repeat(1000), () => fs.writeFileSync(${JSON.stringify(wrote)}, ""));
          if (text.includes("q")) process.stdout.write("END", () => process.exit(0));
        });
        process.stdout.write("READY");
      `]);
      try {
        await paused.until("READY", (output) => output.includes("READY"));
        paused.session.pause();
        paused.session.write("go");
        await appears(wrote);
        expect(paused.output()).not.toContain("B");
        paused.session.write("\x03");
        await appears(interrupted);
        expect(paused.output()).not.toContain("B");
        paused.session.resume();
        await paused.until("the held output", (output) => output.includes(held));
        paused.session.write("q");
        expect(await paused.exited).toBe(0);
        expect(paused.output()).toEndWith("END");
      } finally {
        paused.session.kill();
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15_000);

    it("writes a lone surrogate as U+FFFD, the way JavaScript encodes it", async () => {
      const echo = run("node", ["-e", `
        process.stdin.setRawMode(true);
        process.stdin.once("data", (data) => process.stdout.write("HEX:" + data.toString("hex"), () => process.exit(0)));
        process.stdout.write("READY");
      `]);
      try {
        await echo.until("READY", (output) => output.includes("READY"));
        echo.session.write("a\ud83db");
        expect(await echo.exited).toBe(0);
        expect(echo.output()).toContain("HEX:61efbfbd62");
      } finally { echo.session.kill(); }
    }, 15_000);

    it("reaps both processes when killed with output paused", async () => {
      const tag = `ovis-pty-reap-${crypto.randomUUID()}`;
      const flood = run("node", ["-e", `/* ${tag} */ setInterval(() => process.stdout.write("x".repeat(4096)), 5);`]);
      try {
        await flood.until("output", (output) => output.length > 0);
        flood.session.pause();
        flood.session.kill();
        await flood.session.exited;
        expect(Bun.spawnSync(["pgrep", "-f", tag]).stdout.length).toBe(0);
      } finally { flood.session.kill(); }
    }, 15_000);

    // the Node host signals the command alone, and exits right after its SIGKILL: only the Rust one promises these
    it.skipIf(host !== "rust")("kills the command's whole process group when stopped, even one ignoring SIGHUP", async () => {
      const tag = sleepTag();
      const stubborn = run("sh", STUBBORN_GROUP(tag, "wait"));
      try {
        await stubborn.until("READY", (output) => output.includes("READY"));
        stubborn.session.kill();
        await stubborn.session.exited;
        expect(await gone(tag)).toBe(true);
      } finally {
        stubborn.session.kill();
        Bun.spawnSync(["pkill", "-KILL", "-f", tag]);
      }
    }, 15_000);

    it.skipIf(host !== "rust")("kills what is left of the command's process group when the command exits", async () => {
      const tag = sleepTag();
      const leaving = run("sh", STUBBORN_GROUP(tag, "exit 0"));
      try {
        expect(await leaving.exited).toBe(0);
        expect(await gone(tag)).toBe(true);
      } finally {
        leaving.session.kill();
        Bun.spawnSync(["pkill", "-KILL", "-f", tag]);
      }
    }, 15_000);

    it.skipIf(host !== "rust")("holds output paused when the command exits, and delivers all of it on resume", async () => {
      const dir = mkdtempSync(join(tmpdir(), "ovis-pty-exit-paused-"));
      const wrote = join(dir, "wrote");
      const ending = run("node", ["-e", `
        const fs = require("fs");
        process.stdin.setRawMode(true);
        process.stdin.once("data", () => process.stdout.write("Q".repeat(1000), () => { fs.writeFileSync(${JSON.stringify(wrote)}, ""); process.exit(3); }));
        process.stdout.write("READY");
      `]);
      try {
        await ending.until("READY", (output) => output.includes("READY"));
        ending.session.pause();
        ending.session.write("go");
        await appears(wrote);
        await Bun.sleep(400); // fixed wait: past the 200 ms a host may keep reading once its command has exited
        expect(ending.output()).not.toContain("Q");
        ending.session.resume();
        expect(await ending.exited).toBe(3);
        expect(ending.output()).toContain("Q".repeat(1000));
      } finally {
        ending.session.kill();
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15_000);
  });
}

parity("node");
parity("rust");

/** The Rust host run directly, so a test can write what PtySession never does: frames cut off, floods. */
function direct(args: string[]) {
  const proc = Bun.spawn([RUST_HOST ?? "", "40", "5", ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let output = "";
  const waiters = new Set<() => void>();
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) {
      output += decoder.decode(chunk, { stream: true });
      for (const waiter of [...waiters]) waiter();
    }
  })();
  let errors = "";
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr) errors += decoder.decode(chunk, { stream: true });
  })();
  const until = (label: string, text: string) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(test); reject(new Error(`no ${label} in ${LIMIT_MS} ms: ${JSON.stringify(output.slice(-200))}`)); }, LIMIT_MS);
    const test = () => {
      if (!output.includes(text)) return;
      clearTimeout(timer);
      waiters.delete(test);
      resolve();
    };
    waiters.add(test);
    test();
  });
  /** the host's peak resident memory so far, in MiB */
  const peakMiB = () => Number(readFileSync(`/proc/${proc.pid}/status`, "utf8").match(/VmHWM:\s+(\d+)/)?.[1]) / 1024;
  /** how many diagnostic lines the host wrote */
  const errorLines = () => errors.split("\n").filter(Boolean).length;
  return { proc, until, peakMiB, errorLines };
}

/** Reports each resize, and never reads its input: what it is sent piles up in the pty (raw, so the line discipline keeps it). */
const UNREAD = ["sh", "-c", 'stty raw -echo; exec node -e "$1"', "sh", `
  const out = process.stdout;
  process.on("SIGWINCH", () => out.write("WINCH " + out.columns + "x" + out.rows));
  out.write("READY");
  setInterval(() => {}, 1000);
`];
const RESIZE = `${JSON.stringify({ t: "r", c: 60, r: 10 })}\n`;

describe.skipIf(!built || process.platform !== "linux")("the Rust PTY host under more input than it may hold", () => {
  it("discards a control frame that never ends once it passes the limit, and takes the next one", async () => {
    const host = direct(UNREAD);
    try {
      await host.until("READY", "READY");
      const chunk = Buffer.alloc(1024 * 1024, 0x78);
      host.proc.stdin.write('{"t":"i","d":"');
      for (let mib = 0; mib < 96; mib++) {
        host.proc.stdin.write(chunk);
        await host.proc.stdin.flush();
      }
      host.proc.stdin.write(`"}\n${RESIZE}`);
      await host.proc.stdin.flush();
      await host.until("the resize", "WINCH 60x10");
      expect(host.peakMiB()).toBeLessThan(48);
    } finally {
      host.proc.kill();
      await host.proc.exited;
    }
  }, 30_000);

  it("drops 64 KiB input frames a command does not read once 16 MiB wait, and still takes control frames", async () => {
    const host = direct(UNREAD);
    try {
      await host.until("READY", "READY");
      const frame = `${JSON.stringify({ t: "i", d: "y".repeat(64 * 1024) })}\n`;
      for (let sent = 1; sent <= 1536; sent++) {
        host.proc.stdin.write(frame);
        if (sent % 16 === 0) await host.proc.stdin.flush();
      }
      host.proc.stdin.write(RESIZE);
      await host.proc.stdin.flush();
      await host.until("the resize", "WINCH 60x10");
      expect(host.peakMiB()).toBeLessThan(48);
    } finally {
      host.proc.kill();
      await host.proc.exited;
    }
  }, 30_000);

  it("keeps a flood of tiny and empty input frames a command does not read within the limit, and still takes control frames", async () => {
    const host = direct(UNREAD);
    try {
      await host.until("READY", "READY");
      const pairs = `${JSON.stringify({ t: "i", d: "a" })}\n${JSON.stringify({ t: "i", d: "" })}\n`.repeat(4096);
      for (let sent = 0; sent < 1_500_000; sent += 4096) {
        host.proc.stdin.write(pairs);
        await host.proc.stdin.flush();
      }
      host.proc.stdin.write(RESIZE);
      await host.proc.stdin.flush();
      await host.until("the resize", "WINCH 60x10");
      expect(host.peakMiB()).toBeLessThan(48);
      // one line for the overflow, not one per frame dropped
      expect(host.errorLines()).toBeLessThanOrEqual(2);
    } finally {
      host.proc.kill();
      await host.proc.exited;
    }
  }, 60_000);

  it("kills the command's process group when the host aborts", async () => {
    const tag = sleepTag();
    const host = direct(["sh", ...STUBBORN_GROUP(tag, "wait")]);
    try {
      await host.until("READY", "READY");
      process.kill(host.proc.pid, "SIGABRT");
      await host.proc.exited;
      expect(host.proc.signalCode).toBe("SIGABRT");
      expect(await gone(tag)).toBe(true);
    } finally {
      host.proc.kill();
      Bun.spawnSync(["pkill", "-KILL", "-f", tag]);
    }
  }, 15_000);
});
