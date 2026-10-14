import { describe, expect, it } from "bun:test";
import { codeIsFilePath, fileLineTarget, pathParts, splitFilePaths } from "./filePaths.ts";

const paths = (text: string) => splitFilePaths(text).filter((part) => typeof part !== "string").map((part) => (part as { path: string }).path);

describe("file paths in chat text", () => {
  it("keeps line references whole in prose and code spans", () => {
    const targets = ["src/app.ts:12", "src/app.ts:12:8", "src/app.ts#L12", "src/app.ts#L12-L18", "src/app.ts#L12-18"];
    expect(paths(targets.join(" "))).toEqual(targets);
    for (const target of targets) expect(codeIsFilePath(target)).toBe(true);
    for (const target of ["Math.random:12", "tool.monitor#L12", "1.2.3:12"]) expect(codeIsFilePath(target)).toBe(false);
    expect(splitFilePaths("see src/app.ts:12:8.")).toEqual(["see ", { path: "src/app.ts:12:8" }, "."]);
  });
  it("finds paths with a folder and an extension, absolute, ~ or relative", () => {
    expect(paths("Saved to docs/screenshots/demo-mobile.mp4 and ~/out/shot.png, see /tmp/run.log.")).toEqual([
      "docs/screenshots/demo-mobile.mp4", "~/out/shot.png", "/tmp/run.log",
    ]);
    expect(paths("./scripts/capture.ts 에서 확인")).toEqual(["./scripts/capture.ts"]);
    // the text around a path is kept, whole
    expect(splitFilePaths("open src/a.ts now")).toEqual(["open ", { path: "src/a.ts" }, " now"]);
  });

  it("leaves words, versions and bare names as text", () => {
    expect(paths("and/or, e.g. v1.2.3, 1.0/2.5, README.md, TCP/IP")).toEqual([]);
  });

  it("starts a path once in a run of plus signs, not at every one", () => {
    // each `+` is a character a path may hold: tried from every one of them, a line of 48,000 takes half a second
    const start = performance.now();
    expect(splitFilePaths("+".repeat(48_000))).toEqual(["+".repeat(48_000)]);
    expect(splitFilePaths("+/".repeat(24_000))).toHaveLength(1);
    expect(performance.now() - start).toBeLessThan(250);
    // a plus sign before or inside a path reads as it did
    expect(paths("+src/app.ts and c++/x/y.cc, a+b/c.ts")).toEqual(["+src/app.ts", "c++/x/y.cc", "a+b/c.ts"]);
    expect(splitFilePaths("+~/notes/a.md")).toEqual(["+", { path: "~/notes/a.md" }]);
  });

  it("takes a code span that is one file name or path", () => {
    for (const code of ["README.md", "src/app.ts", "~/x/y.png", "/tmp/a.log", "docs/demo.mp4"]) expect(codeIsFilePath(code)).toBe(true);
    for (const code of ["bun test", "1.2.3", "git log --oneline", "a/b", "foo()", "x.y()", "tool.monitor", "Math.random", "process.env", "os.path", "process.env.HOME", "console.log", "JSON.parse"]) expect(codeIsFilePath(code)).toBe(false);
    // a file of any language still opens: what is refused above is known code, not an unknown extension
    for (const code of ["main.c", "util.h", "App.vue", "go.mod", "Cargo.lock", "nginx.conf", "config.env", "src/process.env", "os.py", "std.rs", "tool.ts", "fmt.go", "app.dev", "tool.vue", "std.lock", "os.conf", "Math.js", "process.yml", "README.org", "notes.io", "example.com"]) expect(codeIsFilePath(code)).toBe(true);
  });
});

describe("fileLineTarget", () => {
  it("selects only the first line, not the column or range end", () => {
    for (const suffix of [":12", ":12:8", "#L12", "#L12-L18", "#L12-18"]) {
      expect(fileLineTarget(`src/app.ts${suffix}`)).toEqual({ path: "src/app.ts", line: 12 });
    }
    expect(fileLineTarget("C:\\repo\\app.ts:12:8")).toEqual({ path: "C:\\repo\\app.ts", line: 12 });
  });
  it("leaves ordinary names intact and ignores invalid line numbers", () => {
    expect(fileLineTarget("src/app.ts")).toEqual({ path: "src/app.ts", line: null });
    expect(fileLineTarget("docs/a.md#usage")).toEqual({ path: "docs/a.md#usage", line: null });
    for (const suffix of [":0", "#L0", ":99999999999999999999"]) {
      expect(fileLineTarget(`src/app.ts${suffix}`)).toEqual({ path: "src/app.ts", line: null });
    }
  });
});

describe("pathParts", () => {
  it("splits a path into its folder, the name's stem and its extension", () => {
    expect(pathParts("/a/b/c.md")).toEqual({ folder: "/a/b", stem: "c", extension: ".md" });
    expect(pathParts("C:\\repo\\a.tar.gz")).toEqual({ folder: "C:\\repo", stem: "a.tar", extension: ".gz" });
    expect(pathParts("~/notes.txt")).toEqual({ folder: "~", stem: "notes", extension: ".txt" });
  });

  it("keeps the root as the folder of a file directly in it", () => {
    expect(pathParts("/c.md").folder).toBe("/");
    expect(pathParts("C:\\c.md").folder).toBe("C:\\");
  });

  it("has no folder for a bare name", () => {
    expect(pathParts("notes.txt")).toEqual({ folder: "", stem: "notes", extension: ".txt" });
  });

  it("gives a dotfile, a name without a dot and a trailing dot no extension", () => {
    expect(pathParts("/x/.gitignore")).toEqual({ folder: "/x", stem: ".gitignore", extension: "" });
    expect(pathParts("/x/Dockerfile")).toEqual({ folder: "/x", stem: "Dockerfile", extension: "" });
    expect(pathParts("/x/name.")).toEqual({ folder: "/x", stem: "name.", extension: "" });
  });
});
