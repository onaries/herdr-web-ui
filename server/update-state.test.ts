import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptLegacyDir, defaultStateDir, moveLegacyStateDir } from "./update-state.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const configHome = (): string => {
  const root = mkdtempSync(join(tmpdir(), "ovis-state-dir-"));
  roots.push(root);
  return root;
};
const withDevices = (dir: string): string => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "devices.json"), "{\"paired\":1}");
  return dir;
};

describe("the state dir from before the rename", () => {
  it("stays where it is until its owner moves it, so resolving the dir never moves anything", () => {
    const config = configHome();
    withDevices(join(config, "herdr-web-ui"));
    expect(defaultStateDir({ XDG_CONFIG_HOME: config })).toBe(join(config, "herdr-web-ui"));
    expect(lstatSync(join(config, "herdr-web-ui")).isDirectory()).toBe(true);
    expect(existsSync(join(config, "ovis"))).toBe(false);
  });

  it("moves to its new name, leaving a link at the old name, and a second move changes nothing", () => {
    const config = configHome();
    withDevices(join(config, "herdr-web-ui"));
    adoptLegacyDir(join(config, "herdr-web-ui"), join(config, "ovis"));
    adoptLegacyDir(join(config, "herdr-web-ui"), join(config, "ovis"));
    expect(defaultStateDir({ XDG_CONFIG_HOME: config })).toBe(join(config, "ovis"));
    expect(readFileSync(join(config, "ovis", "devices.json"), "utf8")).toBe("{\"paired\":1}");
    expect(lstatSync(join(config, "herdr-web-ui")).isSymbolicLink()).toBe(true);
    // through the link, an older release still finds the same files
    expect(readFileSync(join(config, "herdr-web-ui", "devices.json"), "utf8")).toBe("{\"paired\":1}");
  });

  it("is followed when it is a link to state kept elsewhere", () => {
    const config = configHome();
    const elsewhere = withDevices(join(config, "elsewhere"));
    symlinkSync(elsewhere, join(config, "herdr-web-ui"));
    expect(readFileSync(join(defaultStateDir({ XDG_CONFIG_HOME: config }), "devices.json"), "utf8")).toBe("{\"paired\":1}");
    adoptLegacyDir(join(config, "herdr-web-ui"), join(config, "ovis"));
    expect(readFileSync(join(defaultStateDir({ XDG_CONFIG_HOME: config }), "devices.json"), "utf8")).toBe("{\"paired\":1}");
    expect(readFileSync(join(elsewhere, "devices.json"), "utf8")).toBe("{\"paired\":1}");
  });

  it("is not left behind for an empty new dir", () => {
    const config = configHome();
    withDevices(join(config, "herdr-web-ui"));
    mkdirSync(join(config, "ovis"));
    expect(defaultStateDir({ XDG_CONFIG_HOME: config })).toBe(join(config, "herdr-web-ui"));
    adoptLegacyDir(join(config, "herdr-web-ui"), join(config, "ovis"));
    expect(readFileSync(join(defaultStateDir({ XDG_CONFIG_HOME: config }), "devices.json"), "utf8")).toBe("{\"paired\":1}");
  });

  it("stays in use, and says so, when the new dir already holds other files", () => {
    const config = configHome();
    withDevices(join(config, "herdr-web-ui"));
    mkdirSync(join(config, "ovis"));
    writeFileSync(join(config, "ovis", "other.json"), "{}");
    const said = spyOn(console, "error").mockImplementation(() => {});
    try {
      adoptLegacyDir(join(config, "herdr-web-ui"), join(config, "ovis"));
      expect(said).toHaveBeenCalledTimes(1);
    } finally { said.mockRestore(); }
    expect(defaultStateDir({ XDG_CONFIG_HOME: config })).toBe(join(config, "herdr-web-ui"));
    expect(lstatSync(join(config, "herdr-web-ui")).isDirectory()).toBe(true);
  });

  it("is not created for a fresh install", () => {
    const config = configHome();
    adoptLegacyDir(join(config, "herdr-web-ui"), join(config, "ovis"));
    expect(defaultStateDir({ XDG_CONFIG_HOME: config })).toBe(join(config, "ovis"));
    expect(existsSync(join(config, "herdr-web-ui"))).toBe(false);
  });

  it("is moved once per process, and not at all under OVIS_STATE_DIR", () => {
    const [skipped, first, later] = [configHome(), configHome(), configHome()];
    for (const config of [skipped, first, later]) withDevices(join(config, "herdr-web-ui"));
    moveLegacyStateDir({ XDG_CONFIG_HOME: skipped, OVIS_STATE_DIR: "/srv/ovis" });
    moveLegacyStateDir({ XDG_CONFIG_HOME: first });
    moveLegacyStateDir({ XDG_CONFIG_HOME: later });
    expect(lstatSync(join(skipped, "herdr-web-ui")).isDirectory()).toBe(true);
    expect(lstatSync(join(first, "herdr-web-ui")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(later, "herdr-web-ui")).isDirectory()).toBe(true);
  });

  it("gives way to OVIS_STATE_DIR", () => {
    const config = configHome();
    withDevices(join(config, "herdr-web-ui"));
    expect(defaultStateDir({ XDG_CONFIG_HOME: config, OVIS_STATE_DIR: "/srv/ovis" })).toBe("/srv/ovis");
  });
});
