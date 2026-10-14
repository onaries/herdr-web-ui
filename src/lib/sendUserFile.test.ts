import { expect, test } from "bun:test";
import { sendUserFileCall } from "./sendUserFile.ts";

test("a SendUserFile call reads as its caption and the files it names", () => {
  expect(sendUserFileCall({ files: ["/tmp/a.png", "/tmp/b.png"], caption: "Here you go", display: "render" })).toEqual({
    caption: "Here you go",
    files: ["/tmp/a.png", "/tmp/b.png"],
  });
});

test("a missing or blank caption reads as empty, not as a reason to drop the call", () => {
  expect(sendUserFileCall({ files: ["/tmp/a.png"] })).toEqual({ caption: "", files: ["/tmp/a.png"] });
  expect(sendUserFileCall({ files: ["/tmp/a.png"], caption: "   " })).toEqual({ caption: "", files: ["/tmp/a.png"] });
});

test("a path that is not a string, or blank, is dropped; none left is no call", () => {
  expect(sendUserFileCall({ files: ["/tmp/a.png", "", 5, "  "] })).toEqual({ caption: "", files: ["/tmp/a.png"] });
  expect(sendUserFileCall({ files: ["", 5] })).toBeNull();
});

test("no files array at all, or one that is not an array, is no call", () => {
  expect(sendUserFileCall({ command: "ls" })).toBeNull();
  expect(sendUserFileCall({ files: "not-an-array" })).toBeNull();
  expect(sendUserFileCall({})).toBeNull();
});
