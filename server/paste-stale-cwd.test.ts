import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { pasteDirectoryForPane } from "./paste.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-paste-"));
const fallback = join(tmpdir(), "herdr-web-ui", ".herdr-web-ui");
const override = process.env["HERDR_WEB_PASTE_DIR"];

beforeEach(() => {
  delete process.env["HERDR_WEB_PASTE_DIR"];
});
afterEach(() => {
  if (override === undefined) delete process.env["HERDR_WEB_PASTE_DIR"];
  else process.env["HERDR_WEB_PASTE_DIR"] = override;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("pasteDirectoryForPane", () => {
  it("writes beside a cwd the OS still has", () => {
    const live = join(root, "live");
    mkdirSync(live);
    expect(pasteDirectoryForPane(live)).toBe(join(live, ".herdr-web-ui"));
  });

  it("falls back for a cwd that is gone, marked deleted, or not a directory", () => {
    const gone = join(root, "gone");
    const file = join(root, "notes.txt");
    writeFileSync(file, "x");
    expect(pasteDirectoryForPane(gone)).toBe(fallback);
    expect(pasteDirectoryForPane(`${gone} (deleted)`)).toBe(fallback);
    expect(pasteDirectoryForPane(file)).toBe(fallback);
    expect(pasteDirectoryForPane(null)).toBe(fallback);
    expect(pasteDirectoryForPane(undefined)).toBe(fallback);
    expect(pasteDirectoryForPane("")).toBe(fallback);
  });

  it("keeps the configured paste directory even when the pane cwd is gone", () => {
    process.env["HERDR_WEB_PASTE_DIR"] = "~/pastes";
    expect(pasteDirectoryForPane(join(root, "gone"))).toBe(join(homedir(), "pastes"));
  });
});
