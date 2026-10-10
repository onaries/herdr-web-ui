import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isolate } from "./check.ts";
import { DISPOSABLE_CONFIG_ENV, DISPOSABLE_CONFIG_FILE, disposableConfig } from "./disposable-config.ts";

const made: string[] = [];
// the root and prefix `isolate` uses: its session socket path has to fit a unix socket address
const scratch = (): string => { const dir = mkdtempSync(join(existsSync("/tmp") ? "/tmp" : tmpdir(), "hwc-")); made.push(dir); return dir; };
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });
const socketIn = (config: string) => join(config, "herdr", "sessions", "herdr-web-ui-test", "herdr.sock");

describe("disposableConfig", () => {
  it("is the config directory of a check run, as `isolate` hands it to the tests", () => {
    const { env } = isolate({}, scratch());
    expect(disposableConfig(env, socketIn(env["XDG_CONFIG_HOME"]!))).toBe(env["XDG_CONFIG_HOME"]!);
  });

  it("is not a config directory of the user's own, however far from ~/.config it lies", () => {
    const own = scratch();
    expect(disposableConfig({ XDG_CONFIG_HOME: own }, socketIn(own))).toBeNull();
    expect(disposableConfig({}, socketIn(own))).toBeNull();
  });

  it("takes neither the variable nor the file alone for a check run", () => {
    const own = scratch();
    expect(disposableConfig({ XDG_CONFIG_HOME: own, [DISPOSABLE_CONFIG_ENV]: own }, socketIn(own))).toBeNull();
    writeFileSync(join(own, DISPOSABLE_CONFIG_FILE), "");
    expect(disposableConfig({ XDG_CONFIG_HOME: own }, socketIn(own))).toBeNull();
    expect(disposableConfig({ XDG_CONFIG_HOME: own, [DISPOSABLE_CONFIG_ENV]: own }, socketIn(own))).toBe(own);
  });

  it("refuses a registry or a socket that is not in the directory the run named", () => {
    const { env } = isolate({}, scratch());
    const config = env["XDG_CONFIG_HOME"]!;
    const elsewhere = scratch();
    expect(disposableConfig({ ...env, XDG_CONFIG_HOME: elsewhere }, socketIn(config))).toBeNull();
    expect(disposableConfig(env, socketIn(elsewhere))).toBeNull();
    expect(disposableConfig(env, join(`${config}-other`, "herdr", "herdr.sock"))).toBeNull();
  });
});
