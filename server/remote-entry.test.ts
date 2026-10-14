import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join as winJoin } from "node:path/win32";

const entryLines = readFileSync(new URL("./remote-entry.ts", import.meta.url), "utf8").split("\n");
const herdrConfigLine = entryLines.find((line) => line.startsWith("const herdrConfig ="));
const sessionLine = entryLines.find((line) => line.startsWith('const session = process.env["HERDR_REMOTE_SESSION"]'));
const socketLine = entryLines.find((line) => line.startsWith('process.env["HERDR_SOCKET"] ='));
if (!herdrConfigLine || !sessionLine || !socketLine) throw new Error("remote-entry socket setup was not found");

function windowsSocket(env: Record<string, string | undefined>): string {
  const evaluateSocket = new Function(
    "windows",
    "process",
    "join",
    "homedir",
    `${herdrConfigLine}\n${sessionLine}\n${socketLine}\nreturn process.env["HERDR_SOCKET"];`,
  );
  return String(evaluateSocket(true, { env }, winJoin, () => "C:\\Users\\u"));
}

describe("remote entry socket selection", () => {
  it("uses XDG_CONFIG_HOME before APPDATA on Windows", () => {
    // regression (fails on main): a set XDG_CONFIG_HOME owns herdr's Windows socket root
    expect(windowsSocket({ XDG_CONFIG_HOME: "C:\\Temp\\xdg", APPDATA: "C:\\Users\\u\\AppData\\Roaming", HERDR_REMOTE_SESSION: "qa" }))
      .toBe("C:\\Temp\\xdg\\herdr\\sessions\\qa\\herdr.sock");
  });

  it("uses APPDATA when Windows XDG_CONFIG_HOME is absent", () => {
    // control: APPDATA stays the Windows fallback
    expect(windowsSocket({ APPDATA: "C:\\Users\\u\\AppData\\Roaming", HERDR_REMOTE_SESSION: "qa" }))
      .toBe("C:\\Users\\u\\AppData\\Roaming\\herdr\\sessions\\qa\\herdr.sock");
  });

  it("uses the roaming profile when both Windows config variables are absent", () => {
    // control: preserve the standard Windows profile fallback
    expect(windowsSocket({ HERDR_REMOTE_SESSION: "qa" }))
      .toBe("C:\\Users\\u\\AppData\\Roaming\\herdr\\sessions\\qa\\herdr.sock");
  });
});
