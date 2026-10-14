import { describe, expect, test } from "bun:test";
import { composerImageMimeType, normalizeComposerImageFile } from "./composerImageMime.ts";

describe("composerImageMimeType", () => {
  test("infers supported image types for missing and generic MIME types", () => {
    const cases: readonly [string, string][] = [
      ["shot.PNG", "image/png"],
      ["photo.jpg", "image/jpeg"],
      ["photo.jpeg", "image/jpeg"],
      ["animation.gif", "image/gif"],
      ["screen.webp", "image/webp"],
    ];
    for (const [name, mime] of cases) {
      expect(composerImageMimeType(name, "")).toBe(mime);
      expect(composerImageMimeType(name, "application/octet-stream")).toBe(mime);
    }
  });

  test("leaves explicit MIME types and unknown extensions alone", () => {
    expect(composerImageMimeType("photo.png", "text/plain")).toBeNull();
    expect(composerImageMimeType("photo.heic", "")).toBeNull();
    expect(composerImageMimeType("photo", "application/octet-stream")).toBeNull();
    expect(composerImageMimeType(".png", "")).toBeNull();
  });

  test("normalizes a generic image file for the image upload path", async () => {
    const source = new File(["image bytes"], "screen.png", { type: "application/octet-stream", lastModified: 123 });
    const normalized = normalizeComposerImageFile(source);
    expect(normalized).not.toBe(source);
    expect(normalized.type).toBe("image/png");
    expect(normalized.name).toBe(source.name);
    expect(normalized.lastModified).toBe(source.lastModified);
    expect(await normalized.text()).toBe("image bytes");
    const unknown = new File(["x"], "notes.txt");
    expect(normalizeComposerImageFile(unknown)).toBe(unknown);
  });
});
