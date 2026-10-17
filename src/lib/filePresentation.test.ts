import { expect, it } from "bun:test";

import { filePresentation } from "./filePresentation.ts";

it("places text and source extensions beside the pane before metadata arrives", () => {
  for (const path of ["notes.txt", "src/App.tsx:42:8", "docs/README.MD#L6-L10", "report.HTML", "config.yaml", "C:\\work\\app.py"]) {
    expect(filePresentation(path)).toBe("panel");
  }
});

it("places media, binary, unknown and extensionless paths in the popup", () => {
  for (const path of ["photo.png", "preview.svg", "demo.webm", "song.mp3", "report.pdf", "archive.zip", "app.exe", "data.bin", "unknown.custom", "/docs", "/docs.txt/", ".gitignore", "README"]) {
    expect(filePresentation(path)).toBe("popup");
  }
});
