import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { appName, renameManifest, renameShell } from "./static.ts";

// The sources Vite builds from: public/ is copied into dist/ as it is, and the meta survives the build.
const root = join(import.meta.dir, "..");
const manifest = readFileSync(join(root, "public", "manifest.webmanifest"), "utf8");
const shell = readFileSync(join(root, "index.html"), "utf8");

describe("HERDR_WEB_APP_NAME", () => {
  const previous = process.env["HERDR_WEB_APP_NAME"];
  afterEach(() => {
    if (previous === undefined) delete process.env["HERDR_WEB_APP_NAME"]; else process.env["HERDR_WEB_APP_NAME"] = previous;
  });

  it("is off when unset or blank", () => {
    delete process.env["HERDR_WEB_APP_NAME"];
    expect(appName()).toBeNull();
    process.env["HERDR_WEB_APP_NAME"] = "   ";
    expect(appName()).toBeNull();
    process.env["HERDR_WEB_APP_NAME"] = "  work laptop ";
    expect(appName()).toBe("work laptop");
  });

  it("renames the manifest and keeps everything else, the id included", () => {
    const renamed = JSON.parse(renameManifest(manifest, "laptop")) as Record<string, unknown>;
    const original = JSON.parse(manifest) as Record<string, unknown>;
    expect(renamed).toEqual({ ...original, name: "laptop", short_name: "laptop" });
    expect(renamed["id"]).toBe("/");
  });

  it("renames the iOS home-screen title in the shell and nothing else", () => {
    const renamed = renameShell(shell, "laptop");
    expect(renamed).toContain('<meta name="apple-mobile-web-app-title" content="laptop" />');
    expect(renamed.replace("content=\"laptop\"", "content=\"herdr\"")).toBe(shell);
  });

  it("escapes the name in the shell", () => {
    const renamed = renameShell(shell, `a"b<c>&$1 $&`);
    expect(renamed).toContain('content="a&quot;b&lt;c&gt;&amp;$1 $&amp;"');
  });
});
