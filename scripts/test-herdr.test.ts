import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { TEST_SESSION, testSocketPath } from "./test-herdr.ts";

const socket = (root: string): string => join(root, "herdr", "sessions", TEST_SESSION, "herdr.sock");

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
