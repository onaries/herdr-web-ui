import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MachineEvent } from "../shared/machines.ts";
import type { AgentRowTokens } from "../shared/pane-tokens.ts";
import { agentRowTokens, HerdrSidebarConfig, herdrConfigPath } from "./herdr-sidebar.ts";
import { handleMachineRequest } from "./machine-api.ts";
import type { MachineManager } from "./machines.ts";

const dir = mkdtempSync(join(tmpdir(), "herdr-sidebar-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;
/** a config.toml of its own for each test */
const configFile = (text?: string): string => {
  const path = join(dir, `config-${++files}.toml`);
  if (text !== undefined) writeFileSync(path, text);
  return path;
};
const parse = (text: string): AgentRowTokens | null => agentRowTokens(Bun.TOML.parse(text));
const changed = async (config: HerdrSidebarConfig, edit: () => void): Promise<void> => {
  const next = Promise.withResolvers<void>();
  const stop = config.subscribe(() => next.resolve());
  const timeout = setTimeout(() => next.reject(new Error("timed out waiting for sidebar config change")), 5_000);
  try {
    edit();
    await next.promise;
  } finally {
    clearTimeout(timeout);
    stop();
  }
};

describe("herdrConfigPath", () => {
  test("follows herdr: HERDR_CONFIG_PATH, then XDG_CONFIG_HOME on any platform, then the platform's own place", () => {
    expect(herdrConfigPath({ HERDR_CONFIG_PATH: "/etc/h.toml", XDG_CONFIG_HOME: "/x" }, "linux", "/home/me")).toBe("/etc/h.toml");
    expect(herdrConfigPath({ XDG_CONFIG_HOME: "/x" }, "win32", "/home/me")).toBe(join("/x", "herdr", "config.toml"));
    expect(herdrConfigPath({}, "darwin", "/home/me")).toBe(join("/home/me", ".config", "herdr", "config.toml"));
    expect(herdrConfigPath({ APPDATA: "C:/Users/me/AppData/Roaming" }, "win32", "C:/Users/me")).toBe(join("C:/Users/me/AppData/Roaming", "herdr", "config.toml"));
    expect(herdrConfigPath({}, "win32", "C:/Users/me")).toBe(join("C:/Users/me", "AppData", "Roaming", "herdr", "config.toml"));
  });
});

describe("agentRowTokens", () => {
  test("takes the `$name` tokens of herdr's agent rows, in order, each place of one named twice, and leaves the built-ins and styles", () => {
    // the rows herdr-projects adds, and the ones the Quota plugin's README suggests (#1209)
    expect(parse(`
[ui.sidebar.agents]
rows = [["state_icon", "machine", "workspace", { token = "tab", rules = [{ equals = "Agent", hide = true }] }], ["agent"], [{ token = "$summary", dim = true, fg = "#89b4fa" }, "$progress"]]

[ui.sidebar.spaces]
rows = [["state_icon", "workspace"], ["$workspace_only"]]
`)).toEqual({ rows: [{ name: "summary" }, { name: "progress" }], by_agent: {} });
    // herdr tests each place's rules on its own: a place that hides the token leaves the other one
    expect(parse(`[ui.sidebar.agents]\nrows = [["state_icon", "workspace"], ["agent", { token = "$quota", rules = [{ equals = "unknown", hide = true }] }], ["$quota"]]`))
      .toEqual({ rows: [{ name: "quota", rules: [{ equals: "unknown", hide: true }] }, { name: "quota" }], by_agent: {} });
  });

  test("keeps a token's rules only when one of them hides it, without their styles", () => {
    expect(parse(`
[ui.sidebar.agents]
rows = [[
  { token = "$quota", rules = [{ starts_with = "5h", fg = "#f55" }, { equals = "none", ignore_case = true, hide = true }] },
  { token = "$load", fg = "#fff", rules = [{ gt = 80, fg = "#f55", bold = true }, { gt = 50, fg = "#fc0" }] },
  { token = "$eta", rules = [{ lt = 1, hide = true }, { gt = 1, ignore_case = true, hide = true }, { equals = "a", contains = "b", hide = true }, { hide = true }] },
]]
`)?.rows).toEqual([
      { name: "quota", rules: [{ starts_with: "5h" }, { equals: "none", ignore_case: true, hide: true }] },
      { name: "load" },
      // herdr refuses a rule with ignore_case on a number, two conditions, or none: they are left out
      { name: "eta", rules: [{ lt: 1, hide: true }] },
    ]);
  });

  test("an agent's own rows stand beside `rows`, which may be unset", () => {
    expect(parse(`
[ui.sidebar.agents]
rows = [["state_icon", "agent"]]

[ui.sidebar.agents.rows_by_agent]
claude = [["state_icon", "agent"], ["$quota", "$model"]]
codex = [["agent"]]
`)).toEqual({ rows: [], by_agent: { claude: [{ name: "quota" }, { name: "model" }], codex: [] } });
    expect(parse(`[ui.sidebar.agents.rows_by_agent]\nclaude = [["$quota"]]`)).toEqual({ rows: null, by_agent: { claude: [{ name: "quota" }] } });
  });

  test("a config that sets no agent rows, or rows herdr would refuse, names no token", () => {
    expect(parse("onboarding = false")).toBeNull();
    expect(parse("[ui]\nsidebar_width = 30")).toBeNull();
    expect(parse(`[ui.sidebar.agents]\nrow_gap = 1`)).toBeNull();
    expect(parse(`[ui.sidebar.agents]\nrows = ["$quota"]`)).toBeNull();
    // a name herdr's tokens cannot have, and an entry that is no token, are passed over
    expect(parse(`[ui.sidebar.agents]\nrows = [["$", "$has space", 3, { dim = true }, "$ok"]]`)).toEqual({ rows: [{ name: "ok" }], by_agent: {} });
    expect(agentRowTokens(null)).toBeNull();
    expect(agentRowTokens({ ui: [] })).toBeNull();
  });
});

describe("HerdrSidebarConfig", () => {
  test("reads the file, and tells a listener when what the rows draw changes, not when the file merely changes", async () => {
    const path = configFile(`[ui.sidebar.agents]\nrows = [["agent", "$quota"]]`);
    const config = new HerdrSidebarConfig(path, 10);
    expect(config.get()).toEqual({ rows: [{ name: "quota" }], by_agent: {} });
    const told: (AgentRowTokens | null)[] = [];
    const stop = config.subscribe((layout) => told.push(layout));
    try {
      // a change that names the same tokens tells nothing (read now: get() reads the file as the timer does)
      writeFileSync(path, `# a comment\n[ui.sidebar.agents]\nrows = [["state_icon", "agent", "$quota"]]`);
      expect(config.get()).toEqual({ rows: [{ name: "quota" }], by_agent: {} });
      expect(told).toEqual([]);
      // a change one browser's connection reads first is told to those already listening
      writeFileSync(path, `[ui.sidebar.agents]\nrows = [["agent", "$quota", "$summary"]]`);
      expect(config.get()).toEqual({ rows: [{ name: "quota" }, { name: "summary" }], by_agent: {} });
      expect(told).toEqual([{ rows: [{ name: "quota" }, { name: "summary" }], by_agent: {} }]);
      // being edited, or gone: no rows, so the agent rows draw every token
      await changed(config, () => writeFileSync(path, `[ui.sidebar.agents\nrows = [[`));
      expect(told[1]).toBeNull();
      await changed(config, () => {
        rmSync(path);
        writeFileSync(path, `[ui.sidebar.agents]\nrows = [["$eta"]]`);
      });
      expect(told[2]).toEqual({ rows: [{ name: "eta" }], by_agent: {} });
    } finally { stop(); }
    // nobody listens: a read tells no one
    writeFileSync(path, `[ui.sidebar.agents]\nrows = [["$other", "$names"]]`);
    expect(config.get()).toEqual({ rows: [{ name: "other" }, { name: "names" }], by_agent: {} });
    expect(told).toHaveLength(3);
  });

  test("a missing config names no token", () => {
    expect(new HerdrSidebarConfig(configFile()).get()).toBeNull();
  });

  test.each(["\n", "\r\n"])("keeps custom rows with line-start BOMs using %j line endings", (newline) => {
    const path = configFile([
      "\uFEFF# herdr config",
      "\uFEFF[ui.sidebar.agents]",
      '\uFEFFrows = [["$quota", { token = "$summary", rules = [{ equals = "a\uFEFFb", hide = true }] }]]',
      "\uFEFF[ui.sidebar.agents.rows_by_agent]",
      '\uFEFFcodex = [["$progress"]]',
    ].join(newline));
    expect(new HerdrSidebarConfig(path).get()).toEqual({
      rows: [{ name: "quota" }, { name: "summary", rules: [{ equals: "a\uFEFFb", hide: true }] }],
      by_agent: { codex: [{ name: "progress" }] },
    });
  });

  test("falls back when a config becomes a directory", () => {
    const path = configFile(`[ui.sidebar.agents]\nrows = [["$quota"]]`);
    const config = new HerdrSidebarConfig(path);
    expect(config.get()).toEqual({ rows: [{ name: "quota" }], by_agent: {} });
    rmSync(path);
    mkdirSync(path);
    expect(config.get()).toBeNull();
  });

  test.each(['"""', "'''"])("preserves line-start BOMs inside %s multiline rule values", (quote) => {
    const path = configFile([
      "# Delimiters in comments do not open strings: \"\"\" '''",
      `literal = '"""'`,
      `basic = "''' and \\"quoted\\""`,
      "\uFEFF[ui.sidebar.agents]",
      `rows = [[{ token = "$summary", rules = [{ equals = ${quote}first`,
      "\uFEFFsecond",
      `${quote}, hide = true }] }]]`,
      "\uFEFF[ui.sidebar.agents.rows_by_agent]",
      'codex = [["$progress"]]',
    ].join("\n"));
    expect(new HerdrSidebarConfig(path).get()).toEqual({
      rows: [{ name: "summary", rules: [{ equals: "first\n\uFEFFsecond\n", hide: true }] }],
      by_agent: { codex: [{ name: "progress" }] },
    });
  });

  test("honours escaped quotes and quote runs in multiline basic strings", () => {
    const path = configFile([
      "[ui.sidebar.agents]",
      'rows = [[{ token = "$summary", rules = [{ equals = """first\\"""',
      "\uFEFFsecond",
      'last""""", hide = true }] }]]',
      '\uFEFFrows_by_agent = { codex = [["$progress"]] }',
    ].join("\r\n"));
    expect(new HerdrSidebarConfig(path).get()).toEqual({
      rows: [{ name: "summary", rules: [{ equals: 'first"""\n\uFEFFsecond\nlast""', hide: true }] }],
      by_agent: { codex: [{ name: "progress" }] },
    });
  });

  test("falls back for a config larger than the size cap", () => {
    const path = configFile(`[ui.sidebar.agents]\nrows = [["$quota"]]\n#${"x".repeat(1024 * 1024)}`);
    expect(new HerdrSidebarConfig(path).get()).toBeNull();
  });

  test.skipIf(process.platform === "win32")("does not wait for a writer when the config is a FIFO", async () => {
    const path = configFile();
    expect(await Bun.spawn(["mkfifo", path]).exited).toBe(0);
    // A separate process bounds the regression even if get() blocks its event loop.
    const child = Bun.spawn([process.execPath, "-e", `
      import { HerdrSidebarConfig } from ${JSON.stringify(new URL("./herdr-sidebar.ts", import.meta.url).href)};
      console.log(JSON.stringify(new HerdrSidebarConfig(${JSON.stringify(path)}).get()));
    `], { stdout: "pipe", stderr: "pipe", timeout: 2_000 });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toBe("null\n");
  });
});

describe("the machine events", () => {
  test("say herdr's agent rows when a browser connects, and again when they change", async () => {
    const path = configFile(`[ui.sidebar.agents]\nrows = [["$quota"]]`);
    const config = new HerdrSidebarConfig(path, 10);
    const manager = { subscribe: () => () => undefined } as unknown as MachineManager;
    const abort = new AbortController();
    const response = await handleMachineRequest(new Request("http://127.0.0.1:7317/api/machines/events", { signal: abort.signal }), manager, undefined, undefined, false, config);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const events: MachineEvent[] = [];
    let buffer = "";
    const read = async (): Promise<void> => {
      const { value } = await reader.read();
      buffer += new TextDecoder().decode(value);
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)) as MachineEvent);
      }
    };
    try {
      while (events.length === 0) await read();
      expect(events).toEqual([{ type: "herdr-sidebar", agents: { rows: [{ name: "quota" }], by_agent: {} } }]);
      writeFileSync(path, `[ui.sidebar.agents]\nrows = [["$quota", "$progress"]]`);
      while (events.length === 1) await read();
      expect(events[1]).toEqual({ type: "herdr-sidebar", agents: { rows: [{ name: "quota" }, { name: "progress" }], by_agent: {} } });
    } finally {
      abort.abort();
      await reader.cancel().catch(() => undefined);
    }
  });
});
