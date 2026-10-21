import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { agentStandIns, TEST_SESSION, testSocketPath } from "./test-herdr.ts";

const socket = (root: string): string => join(root, "herdr", "sessions", TEST_SESSION, "herdr.sock");

describe("agentStandIns", () => {
  it.skipIf(process.platform === "win32")("answers for a stand-in agent kind on PATH as a missing command does", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-stand-ins-"));
    try {
      const dir = agentStandIns(join(root, "bin"));
      const muse = Bun.which("muse", { PATH: dir });
      expect(muse).toBe(join(dir, "muse"));
      expect(Bun.spawnSync([muse!, "--version"]).exitCode).toBe(127);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("testSocketPath", () => {
  it("follows XDG_CONFIG_HOME first, on Windows too", () => {
    expect(testSocketPath({ XDG_CONFIG_HOME: "/x", APPDATA: "/a" }, "win32")).toBe(socket("/x"));
    expect(testSocketPath({ XDG_CONFIG_HOME: "/x" }, "linux")).toBe(socket("/x"));
  });

  it("uses APPDATA on Windows without it, and ~/.config elsewhere", () => {
    expect(testSocketPath({ APPDATA: "/a" }, "win32")).toBe(socket("/a"));
    expect(testSocketPath({ XDG_CONFIG_HOME: "", APPDATA: "" }, "win32")).toBe(socket(join(homedir(), "AppData", "Roaming")));
    expect(testSocketPath({ APPDATA: "/a" }, "darwin")).toBe(socket(join(homedir(), ".config")));
  });
});
