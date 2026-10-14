import { describe, expect, it } from "bun:test";

import { fileIconKind, folderIconKind } from "./fileIcons.ts";

describe("fileIconKind", () => {
  it("tells code, data, text and media apart by extension, whatever its case", () => {
    expect(fileIconKind("App.tsx")).toBe("code");
    expect(fileIconKind("main.go")).toBe("code");
    expect(fileIconKind("index.html")).toBe("code");
    expect(fileIconKind("styles.css")).toBe("code");
    expect(fileIconKind("settings.json")).toBe("json");
    expect(fileIconKind("ci.yml")).toBe("config");
    expect(fileIconKind("Cargo.toml")).toBe("config");
    expect(fileIconKind("notes.MD")).toBe("text");
    expect(fileIconKind("Photo.PNG")).toBe("image");
    expect(fileIconKind("logo.svg")).toBe("image");
    expect(fileIconKind("clip.mp4")).toBe("video");
    expect(fileIconKind("song.flac")).toBe("audio");
    expect(fileIconKind("site.tar.gz")).toBe("archive");
    expect(fileIconKind("run.sh")).toBe("shell");
    expect(fileIconKind("fix.patch")).toBe("diff");
    expect(fileIconKind("Inter.woff2")).toBe("font");
    expect(fileIconKind("server.pem")).toBe("key");
    expect(fileIconKind("tool.exe")).toBe("binary");
    expect(fileIconKind("rows.csv")).toBe("spreadsheet");
  });

  it("knows the names that have no extension to speak of", () => {
    expect(fileIconKind("README")).toBe("text");
    expect(fileIconKind("LICENSE")).toBe("text");
    expect(fileIconKind("Makefile")).toBe("config");
    expect(fileIconKind("CMakeLists.txt")).toBe("config");
    expect(fileIconKind("Dockerfile")).toBe("config");
    expect(fileIconKind("Dockerfile.dev")).toBe("config");
    expect(fileIconKind("api.Dockerfile")).toBe("config");
    expect(fileIconKind(".gitignore")).toBe("config");
    expect(fileIconKind(".env")).toBe("config");
    expect(fileIconKind(".env.local")).toBe("config");
    expect(fileIconKind(".zshrc")).toBe("shell");
  });

  it("marks a lockfile whatever its extension says", () => {
    expect(fileIconKind("package-lock.json")).toBe("lock");
    expect(fileIconKind("pnpm-lock.yaml")).toBe("lock");
    expect(fileIconKind("bun.lock")).toBe("lock");
    expect(fileIconKind("bun.lockb")).toBe("lock");
    expect(fileIconKind("Cargo.lock")).toBe("lock");
    expect(fileIconKind("go.sum")).toBe("lock");
  });

  it("reads the name off a path with either separator", () => {
    expect(fileIconKind("src/components/RepoChanges.tsx")).toBe("code");
    expect(fileIconKind("/Users/me/Pictures/cat.jpeg")).toBe("image");
    expect(fileIconKind("C:\\repo\\package.json")).toBe("json");
    expect(fileIconKind("docs/README")).toBe("text");
  });

  it("gives an unknown name, a dotfile and a trailing dot the plain file", () => {
    expect(fileIconKind("notes.xyz")).toBe("file");
    expect(fileIconKind(".DS_Store")).toBe("file");
    expect(fileIconKind("name.")).toBe("file");
    expect(fileIconKind("noext")).toBe("file");
    expect(fileIconKind("")).toBe("file");
  });
});

describe("folderIconKind", () => {
  it("marks a repository's .git and no other folder", () => {
    expect(folderIconKind(".git")).toBe("git");
    expect(folderIconKind("src")).toBe("folder");
    expect(folderIconKind(".github")).toBe("folder");
    expect(folderIconKind("node_modules")).toBe("folder");
  });
});
