import { describe, expect, it } from "bun:test";
import type { FileInfo } from "../../shared/protocol.ts";

import { MAX_INLINE_IMAGE_BYTES, markdownImagePath, markdownImagePreview } from "./markdownImages.ts";

describe("markdownImagePath", () => {
  it("reads a relative path from the markdown file's folder", () => {
    expect(markdownImagePath("img/a.png", "/tmp/doc/README.md")).toBe("/tmp/doc/img/a.png");
    expect(markdownImagePath("./a.png?raw=1#x", "/tmp/doc/README.md")).toBe("/tmp/doc/a.png");
    expect(markdownImagePath("../a%20b.png", "/tmp/doc/README.md")).toBe("/tmp/a b.png");
  });
  it("keeps an absolute path and a file URI", () => {
    expect(markdownImagePath("/var/x.png", "/tmp/doc/README.md")).toBe("/var/x.png");
    expect(markdownImagePath("file:///var/x.png", "/tmp/doc/README.md")).toBe("/var/x.png");
    // decoded once: the `%` that `%25` stands for is not read as an escape again
    expect(markdownImagePath("file:///tmp/100%25.png", "/tmp/a.md")).toBe("/tmp/100%.png");
  });
  it("refuses what the page cannot load or place", () => {
    expect(markdownImagePath("https://x.dev/a.png", "/tmp/a.md")).toBeNull();
    expect(markdownImagePath("data:image/png;base64,AA", "/tmp/a.md")).toBeNull();
    expect(markdownImagePath("a.png", "a.md")).toBeNull();
    expect(markdownImagePath("~/a.png", "/tmp/a.md")).toBeNull();
  });
});

it("stats markdown images before loading them and offers oversized ones as downloads", async () => {
  let size = MAX_INLINE_IMAGE_BYTES;
  const statPaths: string[] = [];
  const urls: Array<{ path: string; download: boolean }> = [];
  const fetchInfo = async (path: string): Promise<FileInfo> => {
    statPaths.push(path);
    return { path, name: "a.png", size, modified: "2026-10-11T00:00:00Z", mime: "image/png", kind: "image" };
  };
  const fileUrl = (path: string, download: boolean): string => {
    urls.push({ path, download });
    return download ? "download-url" : "inline-url";
  };

  expect(await markdownImagePreview("img/a.png", "/tmp/doc/README.md", fetchInfo, fileUrl)).toEqual({ kind: "inline", url: "inline-url" });
  size++;
  expect(await markdownImagePreview("img/a.png", "/tmp/doc/README.md", fetchInfo, fileUrl)).toEqual({
    kind: "too-large", size, downloadUrl: "download-url",
  });
  expect(statPaths).toEqual(["/tmp/doc/img/a.png", "/tmp/doc/img/a.png"]);
  expect(urls).toEqual([
    { path: "/tmp/doc/img/a.png", download: false },
    { path: "/tmp/doc/img/a.png", download: true },
  ]);
  expect(await markdownImagePreview("https://example.com/a.png", "/tmp/doc/README.md", fetchInfo, fileUrl)).toBeNull();
  expect(statPaths).toHaveLength(2);
});
