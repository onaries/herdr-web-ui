import { expect, it } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const git = (...args: string[]): string => Bun.spawnSync(["git", ...args], { cwd: root, windowsHide: true }).stdout.toString();

// herdr installs the plugin with a git clone and runs these with sh; a clone under WSL can inherit
// Windows' core.autocrlf=true, and sh stops at the first `\r` ("set: Illegal option -")
it("checks every shell script out with LF, whatever core.autocrlf says", () => {
  const scripts = git("ls-files", "-z").split("\0").filter((path) => path.endsWith(".sh"));
  expect(scripts).toContain("scripts/preflight.sh");
  const eol = git("-c", "core.autocrlf=true", "check-attr", "-z", "eol", "--", ...scripts).split("\0");
  // -z prints path, attribute, value for each file
  const values = new Map(scripts.map((path) => [path, eol[eol.indexOf(path) + 2]]));
  for (const path of scripts) expect([path, values.get(path)]).toEqual([path, "lf"]);
});
