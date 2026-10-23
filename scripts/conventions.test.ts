import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fixedSleepCounts, fixedSleeps, sleepFiles } from "./fixed-sleeps.ts";
import { fail, files, lineOf, read, repo, stripComments } from "./source-scan.ts";

// Repo-wide rules from AGENTS.md that used to be prose only. Each failure says what to change;
// client rules are in src/conventions.test.ts, server rules in server/conventions.test.ts.

const SOURCES = [...files("{src,server,shared,scripts,site,telemetry,integrations}/**/*.{ts,tsx,mjs,js}"), "vite.config.ts"];

/** Module specifiers of static imports and re-exports, side-effect imports and `import("…")` with a literal. */
const SPECIFIER = /(?:^|[\s;])(?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm;

describe("imports", () => {
  it("name relative modules with their extension and never use the @shared alias", () => {
    const offenders = SOURCES.flatMap((file) => {
      const code = stripComments(read(file));
      return [...code.matchAll(SPECIFIER)].flatMap((match) => {
        const specifier = match[1] ?? match[2] ?? match[3]!;
        const bad = specifier.startsWith("@shared/") || (specifier.startsWith(".") && !/\.(?:ts|tsx|mjs|js|css|json|md|svg|png|woff2|html|txt)(?:\?[\w&=-]*)?$/.test(specifier));
        return bad ? [`${file}:${lineOf(code, match.index)}: ${specifier}`] : [];
      });
    });
    fail(offenders, "Imports carry explicit .ts/.tsx extensions and relative paths (AGENTS.md, Code conventions): write \"./x.ts\" or \"../shared/x.ts\", never \"./x\" or \"@shared/x\".");
  });

  it("finds the specifiers", () => {
    const found = (code: string) => [...code.matchAll(SPECIFIER)].map((match) => match[1] ?? match[2] ?? match[3]);
    expect(found("import { a } from \"./a.ts\";\nimport type {\n  B,\n} from '../b';\nimport \"./side.css\";\nconst c = await import(\"./c.tsx\");\nexport * from \"./d.ts\";"))
      .toEqual(["./a.ts", "../b", "./side.css", "./c.tsx", "./d.ts"]);
  });
});

describe("fixed sleeps", () => {
  // A ratchet: scripts/fixed-sleeps.json is every file's count of fixed sleeps when this test was
  // added (see scripts/fixed-sleeps.ts for what counts). A file may lose sleeps, never gain one,
  // and a file that is not listed has none.
  const baseline = JSON.parse(read("scripts/fixed-sleeps.json")) as Record<string, number>;

  /**
   * scripts/fixed-sleeps.json where this branch left origin/main, or null when git or that ref is
   * not there (CI's shallow checkout); a stale branch is compared with its own base, not a main
   * that has moved on.
   */
  const committed = (): Record<string, number> | null => {
    const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    const base = git("merge-base", "HEAD", "origin/main");
    if (base.status !== 0) return null;
    const json = git("show", `${base.stdout.trim()}:scripts/fixed-sleeps.json`);
    return json.status === 0 ? JSON.parse(json.stdout) as Record<string, number> : null;
  };

  it("never raises scripts/fixed-sleeps.json above the one on origin/main", () => {
    const before = committed();
    if (before === null) return;
    const total = (counts: Record<string, number>) => Object.values(counts).reduce((sum, count) => sum + count, 0);
    fail([
      ...Object.entries(baseline).filter(([file, count]) => count > (before[file] ?? 0)).map(([file, count]) => `${file}: ${count}, origin/main has ${before[file] ?? 0}`),
      ...total(baseline) > total(before) ? [`total: ${total(baseline)}, origin/main has ${total(before)}`] : [],
    ], "scripts/fixed-sleeps.json may only shrink: take the new fixed sleep out of the code instead (see the message of the test above for how). A renamed file takes its entry along with the same count, which keeps the total.");
  });

  it("adds no fixed sleep and lowers the baseline when one goes", () => {
    const counts = fixedSleepCounts();
    const grown = Object.entries(counts).filter(([file, count]) => count > (baseline[file] ?? 0));
    fail(grown.flatMap(([file, count]) => [`${file}: ${count} fixed sleeps, baseline ${baseline[file] ?? 0}`, ...fixedSleeps(file).map((line) => `  ${line}`)]),
      "Wait for the condition, not for a set time (AGENTS.md: bounded polls and deadlines, never fixed sleeps): poll in a loop bounded by a deadline (`const deadline = Date.now() + 10_000; while (!done()) { if (Date.now() > deadline) throw new Error(\"…\"); await Bun.sleep(25); }`), or race a timeout against the event (`Promise.race`). A wait that must be fixed (proving that nothing arrives, a settle gap herdr needs) says so with `// fixed wait: <why>` on its line or the line above. Never raise scripts/fixed-sleeps.json; when a file was renamed, move its entry to the new path with the same count.");
    const shrunk = Object.entries(baseline).filter(([file, count]) => (counts[file] ?? 0) < count);
    fail(shrunk.map(([file, count]) => `${file}: ${counts[file] ?? 0} now, baseline ${count}`),
      "Fixed sleeps went away: lower these entries in scripts/fixed-sleeps.json to the counts shown (remove an entry at 0; `bun scripts/fixed-sleeps.ts` prints them all), so they cannot come back.");
  });

  it("lists only files that exist", () => {
    fail(Object.keys(baseline).filter((file) => !existsSync(join(repo, file)) || !sleepFiles().includes(file)),
      "Remove these entries from scripts/fixed-sleeps.json: the files are gone or no longer covered. A renamed file keeps its entry under the new path, with the same count.");
  });

  it("tells a fixed sleep from a bounded poll", () => {
    const found = (code: string) => fixedSleeps("example.ts", code).length;
    expect(found("await Bun.sleep(300);")).toBe(1);
    expect(found("await page.waitForTimeout(500);")).toBe(1);
    expect(found("// fixed wait: nothing may arrive in this time\nawait page.waitForTimeout(500);")).toBe(0);
    expect(found("await new Promise((resolve) => setTimeout(resolve, 1500));")).toBe(1);
    expect(found("while (!ready) await Bun.sleep(20);")).toBe(1);
    expect(found("await new Promise((resolve) => setTimeout(resolve, 0));")).toBe(0);
    expect(found("while (!done() && Date.now() < deadline) await Bun.sleep(25);")).toBe(0);
    expect(found("for (let i = 0; i < 40 && !seen(); i++) await Bun.sleep(50);")).toBe(0);
    expect(found("const deadline = Date.now() + 5000;\nwhile (!await check()) {\n  assert.ok(Date.now() < deadline, \"late\");\n  await Bun.sleep(25);\n}")).toBe(0);
    expect(found("for (;;) {\n  if (seen()) break;\n  if (Date.now() > deadline) throw new Error(\"late\");\n  await Bun.sleep(25);\n}")).toBe(0);
    expect(found("await Promise.race([event, Bun.sleep(1000)]);")).toBe(0);
    expect(found("// fixed wait: nothing may arrive in this time\nawait Bun.sleep(NO_SEND_WAIT_MS);")).toBe(0);
    expect(found("async function f() {\n  while (Date.now() < deadline) {\n    const g = async () => { await Bun.sleep(5); };\n  }\n}")).toBe(1);
    expect(found("await Bun.sleep(1000); // fixed wait:")).toBe(1);
    expect(found("for (let i = 0; i < panes.length; i++) { await Bun.sleep(1000); }")).toBe(1);
    expect(found("for (let attempt = 0; attempt < MAX_TRIES && !seen(); attempt++) await Bun.sleep(50);")).toBe(0);
    expect(found("await new Promise((r) => setTimeout(() => r(), 500));")).toBe(1);
    expect(found("await new Promise(function (r) { setTimeout(r, 500); });")).toBe(1);
  });

  it("counts each call of a sleep helper, not its definition", () => {
    const found = (code: string) => fixedSleeps("example.ts", code).length;
    expect(found("const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));\nawait sleep(10);\nawait sleep(20);")).toBe(2);
    expect(found("function delay(ms) { return Bun.sleep(ms); }\nawait delay(300);")).toBe(1);
    expect(found("const wait = (ms: number) => page.waitForTimeout(ms);\nawait wait(10);\nawait wait(20);")).toBe(2);
    expect(found("import { setTimeout as sleep } from \"node:timers/promises\";\nawait sleep(500);")).toBe(1);
    expect(found("const wait = io.wait ?? Bun.sleep;\nawait wait(5);")).toBe(1);
    expect(found("const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));\nawait tick();\nawait tick(20);")).toBe(1);
    expect(found("const wait = io.wait ?? Bun.sleep;\nwhile (Date.now() < deadline) await wait(25);")).toBe(0);
    // a function that starts with a sleep is not a sleep helper: it counts once, where it sleeps
    expect(found("async function flood() {\n  await Bun.sleep(150);\n  send();\n}\nawait flood();\nawait flood();")).toBe(1);
  });
});

describe("demo transport", () => {
  // Every push to main redeploys the browser demo, whose server is site/demo/transport.ts: an
  // endpoint or WS frame it does not answer is a 404 or a dropped frame there (AGENTS.md,
  // Changing a contract).
  const demo = stripComments(read("site/demo/transport.ts"));
  const exact = new Set([...demo.matchAll(/["'](\/api\/[^"'?]*)["']/g)].map((match) => match[1]!));
  const prefixes = [...demo.matchAll(/\.startsWith\(\s*["'](\/api\/[^"']+)["']\s*\)/g)].map((match) => match[1]!).filter((prefix) => prefix !== "/api/");
  const answered = (route: string) => exact.has(route) || prefixes.some((prefix) => route.startsWith(prefix));

  /**
   * Routes the demo leaves to its catch-all 404, each with its reason. A new route gets an answer in
   * site/demo/transport.ts; add an entry here only for a route the browser never asks the demo for
   * (server to server, or behind a state the demo never reaches).
   */
  const DEMO_404: Record<string, string> = {
    "/api/auth": "the demo is never locked (/api/health says authenticated), so neither the token form nor sign-out runs",
    "/api/bridge": "a remote PC's bridge endpoint, asked by another server, never by the browser",
    "/api/event": "OpenCode v2's own service's event stream, read by this server (opencode-service.ts), never by the browser",
    "/api/info": "OpenCode v2's own service's identity, checked by this server (opencode-service.ts), never by the browser",
    "/api/devices": "Settings → Devices: the demo pairs no devices (listed when this guard was added)",
    "/api/devices/pair": "pairing a device: the demo is never locked, so the pairing form does not run",
    "/api/devices/pair/start": "Settings → Devices: the demo pairs no devices (listed when this guard was added)",
    "/api/pane/conversation/image": "an image in a chat turn: the demo's transcripts carry none (listed when this guard was added)",
    "/api/pane/conversation/tool-output": "a tool call's full output: not part of the demo (listed when this guard was added)",
    "/api/pane/image": "pasting an image: the demo stores no files (listed when this guard was added)",
    "/api/pane/read": "the scrollback read behind a chat with no transcript: the demo answers /api/pane/conversation instead (listed when this guard was added)",
    "/api/pane/selection": "copying a selection across screens: not part of the demo (listed when this guard was added)",
    "/api/preferences": "a 404 turns shared-settings sync off, as on an older server (fetchPreferences, src/lib/api.ts)",
    "/api/updates/check": "the demo's /api/updates says managed: false, so Settings offers no check",
    "/api/updates/install": "the demo's /api/updates says managed: false, so Settings offers no install",
  };
  /** Client frames the demo needs no case for, each with its reason; any other frame gets a case in site/demo/transport.ts. */
  const DEMO_IGNORES: Record<string, string> = {
    "pty-ack": "the demo has no output flow control to release; its switch's default branch drops it",
  };

  it("answers every /api route the server handles", () => {
    const routes = new Set(files("server/**/*.ts").filter((file) => !/\.test\.ts$|\.fake\.ts$/.test(file))
      .flatMap((file) => [...stripComments(read(file)).matchAll(/["'`](\/api\/[\w./-]*[\w.-])["'`]/g)].map((match) => match[1]!)));
    expect(routes.size).toBeGreaterThan(60);
    fail([...routes].filter((route) => !answered(route) && !(route in DEMO_404)).sort(),
      "Answer these routes in route() in site/demo/transport.ts (with fixtures from site/demo/fixtures.ts), so the demo does not 404. Only a route the browser never asks the demo for (server to server, or behind a state the demo never reaches) goes into DEMO_404 in scripts/conventions.test.ts instead, with its reason.");
    fail(Object.keys(DEMO_404).filter((route) => answered(route) || !routes.has(route)),
      "Remove these entries from DEMO_404 in scripts/conventions.test.ts: the demo answers them now, or the server no longer has them.");
  });

  it("handles every WS frame a client sends", () => {
    const protocol = read("shared/protocol.ts");
    const union = protocol.slice(protocol.indexOf("export type ClientMessage ="), protocol.indexOf("export type ServerFeature"));
    const frames = [...union.matchAll(/\|\s*\{\s*type:\s*"([\w-]+)"/g)].map((match) => match[1]!);
    expect(frames.length).toBeGreaterThan(10);
    const cases = new Set([...demo.matchAll(/\bcase\s+"([\w-]+)"\s*:/g)].map((match) => match[1]!));
    fail(frames.filter((frame) => !cases.has(frame) && !(frame in DEMO_IGNORES)),
      "Handle these ClientMessage frames (shared/protocol.ts) in the demo socket's switch in site/demo/transport.ts, answering the way the server would. A frame that needs no answer goes into DEMO_IGNORES in scripts/conventions.test.ts with its reason.");
    fail(Object.keys(DEMO_IGNORES).filter((frame) => cases.has(frame) || !frames.includes(frame)),
      "Remove these entries from DEMO_IGNORES in scripts/conventions.test.ts: the demo handles them now, or the protocol no longer has them.");
  });
});

describe("names from before Ovis", () => {
  // Settings are OVIS_*, the sign-in cookies ovis_token and ovis_device, browser storage keys ovis:*,
  // pasted files <cwd>/.ovis.
  // The old names stay only where an install from before the rename still hands them in.
  const CARRY_OVER: Record<string, string> = {
    "server/legacy-env.ts": "maps each old setting to its new name",
    "server/legacy-env.test.ts": "tests that mapping",
    "src/lib/legacyStorage.ts": "moves old browser storage keys",
    "src/lib/legacyStorage.test.ts": "tests that move",
    "server/auth.ts": "still accepts and clears the old cookies",
    "server/auth.test.ts": "tests the old cookies",
    "server/pty/pty-host.mjs": "keeps the token from the attach under either name",
    "server/pty/session.ts": "keeps the token from the sidecar under either name",
    "server/remote-host.ts": "a remote bundle published before the rename reads the old name",
    "install.sh": "reads the old settings of an earlier install",
    "install.ps1": "reads the old settings of an earlier install",
    "docs/guide.md": "tells users the old names still work",
    "shared/telemetry.ts": "pinned to the deployed telemetry Worker, so not even a comment changes",
  };
  // released notes keep the names they shipped with; telemetry/ is the deployed Worker's source
  const HISTORY = [":!CHANGELOG.md", ":!release-summaries.json", ":!changelog.d", ":!telemetry"];

  it("appear only where an older install hands them in", () => {
    const grep = spawnSync("git", ["grep", "--untracked", "-I", "-l", "-E", "HERDR_WEB_[A-Z0-9_]+|herdr_web_(token|device)|herdr-web-ui[:]|[/\"'`][.]herdr-web-ui([^a-z.-]|$)", "--", ".", ...HISTORY], { cwd: repo, encoding: "utf8" });
    if (grep.status === null || grep.status > 1) return;
    const offenders = grep.stdout.split("\n").filter((file) => file !== "" && !(file in CARRY_OVER));
    fail(offenders, "Use the Ovis names: OVIS_* for settings, ovis_token and ovis_device for cookies, ovis:* for browser storage keys, .ovis for pasted files. The old names are read only by the files in CARRY_OVER (scripts/conventions.test.ts), which carry an older install over.");
  });
});
