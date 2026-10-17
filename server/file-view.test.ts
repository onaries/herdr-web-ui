import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import * as fileView from "./file-view.ts";
import { crossSiteFileRead, fileInfo, fileResponse, locateFile, locateFileInFolder, resolveFilePath } from "./file-view.ts";
import { clearFileCache, filesNamed } from "./files.ts";

describe("file view", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  const temp = () => { const root = mkdtempSync(join(tmpdir(), "herdr-file-view-")); roots.push(root); return root; };

  it("resolves absolute, ~ and pane-relative paths", () => {
    expect(resolveFilePath("/a/b.txt", "/work")).toBe("/a/b.txt");
    expect(resolveFilePath("~/x.png", null)).toBe(join(homedir(), "x.png"));
    expect(resolveFilePath("docs/demo.mp4", "/work/app")).toBe("/work/app/docs/demo.mp4");
    expect(resolveFilePath("docs/demo.mp4", null)).toBeNull();
    expect(resolveFilePath("  ", "/work")).toBeNull();
  });

  it("tells media, text and binary apart, and is null for a folder or nothing", () => {
    const root = temp();
    writeFileSync(join(root, "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(root, "run.log"), "line\n");
    writeFileSync(join(root, "blob"), Buffer.from([1, 0, 2]));
    writeFileSync(join(root, "notes"), "plain words");
    expect(fileInfo(join(root, "a.png"))!.kind).toBe("image");
    expect(fileInfo(join(root, "run.log"))!.kind).toBe("text");
    expect(fileInfo(join(root, "blob"))!.kind).toBe("binary");
    expect(fileInfo(join(root, "notes"))!.kind).toBe("text");
    expect(fileInfo(root)).toBeNull();
    expect(fileInfo(join(root, "missing"))).toBeNull();
  });

  it("serves HTML as sandboxed plain text, and a download as an attachment", async () => {
    const root = temp();
    writeFileSync(join(root, "page.html"), "<script>alert(1)</script>");
    const response = fileResponse(fileInfo(join(root, "page.html"))!, true);
    expect(response.headers.get("content-type")).toStartWith("text/plain");
    expect(response.headers.get("content-security-policy")).toStartWith("sandbox");
    expect(response.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''page.html");
    expect(await response.text()).toBe("<script>alert(1)</script>");
  });

  it("draws an HTML page only when asked to render it, with no origin and no network", async () => {
    const root = temp();
    writeFileSync(join(root, "report.html"), "<p>chart</p>");
    writeFileSync(join(root, "notes.txt"), "<p>not a page</p>");
    const page = fileResponse(fileInfo(join(root, "report.html"))!, false, true);
    expect(page.headers.get("content-type")).toStartWith("text/html");
    const policy = page.headers.get("content-security-policy")!;
    // its script runs, but never with this app's origin, cookie or storage
    expect(policy).toStartWith("sandbox allow-scripts;");
    expect(policy).not.toContain("allow-same-origin");
    // nothing to fetch with: default-src stands in for connect-src
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toContain("connect-src");
    // nor this server's files, whose loading would tell it which exist, nor the web, where a script could send what the page holds
    expect(policy.split("; ").filter((directive) => directive.includes("'self'"))).toEqual(["frame-ancestors 'self'"]);
    expect(policy).not.toContain("http");
    expect(policy).toContain("frame-ancestors 'self'");
    expect(await page.text()).toBe("<p>chart</p>");
    // asked without render, or as a download, it stays the source; another text file never renders
    expect(fileResponse(fileInfo(join(root, "report.html"))!, false).headers.get("content-type")).toStartWith("text/plain");
    expect(fileResponse(fileInfo(join(root, "report.html"))!, true, true).headers.get("content-type")).toStartWith("text/plain");
    const text = fileResponse(fileInfo(join(root, "notes.txt"))!, false, true);
    expect(text.headers.get("content-type")).toStartWith("text/plain");
    expect(text.headers.get("content-security-policy")).toStartWith("sandbox;");
  });

  it("puts a page's own pictures, stylesheet and script into it, and nothing from outside its folder", async () => {
    const root = temp();
    const site = join(root, "site");
    mkdirSync(join(site, "shots"), { recursive: true });
    mkdirSync(join(site, ".ssh"));
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
    writeFileSync(join(site, "shots", "a.png"), png);
    writeFileSync(join(site, "style.css"), "h1 { color: teal }");
    writeFileSync(join(site, "print.css"), "body { display: none }");
    writeFileSync(join(site, "chart.js"), "document.title = 'drawn'; '</script>';");
    writeFileSync(join(site, "config.js"), "const token = 'secret';");
    writeFileSync(join(site, ".ssh", "key.png"), png);
    writeFileSync(join(site, ".env"), "TOKEN=secret");
    writeFileSync(join(site, "notes.txt"), "private notes");
    writeFileSync(join(root, "outside.png"), png);
    symlinkSync(join(root, "outside.png"), join(site, "linked.png"));
    writeFileSync(join(site, "report.html"), [
      `<link rel="stylesheet" href="style.css"><link rel="stylesheet" media="print" href="print.css"><script defer src="./chart.js"></script>`,
      `<script type="text/plain" id="data" src="config.js"></script>`,
      `<img id="shot" src="shots/a.png?v=1">`,
      `<img id="up" src="../outside.png"><img id="link" src="linked.png"><img id="hidden" src=".ssh/key.png">`,
      `<img id="env" src=".env"><img id="text" src="notes.txt"><script id="notjs" src="notes.txt"></script>`,
      `<img id="cdn" src="https://example.com/a.png"><img id="rooted" src="/etc/hosts">`,
      `<img id="unc" src="%5C%5Chost%5Cshare%5Ca.png"><img id="drive" src="C%3A%5Ca.png"><img id="slash" src="%2Fetc%2Fhosts">`,
    ].join(""));
    const html = await fileResponse(fileInfo(join(site, "report.html"))!, false, true).text();
    // its own files, in its folder or below, as the kind of file each element takes, with the element's attributes kept
    const data = (mime: string, text: string) => `data:${mime};base64,${Buffer.from(text).toString("base64")}`;
    expect(html).toContain(`<link rel="stylesheet" href="${data("text/css", "h1 { color: teal }")}">`);
    expect(html).toContain(`<link rel="stylesheet" media="print" href="${data("text/css", "body { display: none }")}">`);
    expect(html).toContain(`<script defer src="${data("text/javascript", "document.title = 'drawn'; '</script>';")}"></script>`);
    expect(html).toContain(`<img id="shot" src="data:image/png;base64,${png.toString("base64")}">`);
    // a script that does not run is a data block: it takes no file, which its neighbour could read
    expect(html).toContain(`<script type="text/plain" id="data" src="config.js"></script>`);
    // nothing above its folder, through a symlink, under a hidden name, or of another kind
    for (const [id, src] of [["up", "../outside.png"], ["link", "linked.png"], ["hidden", ".ssh/key.png"], ["env", ".env"], ["text", "notes.txt"], ["cdn", "https://example.com/a.png"], ["rooted", "/etc/hosts"], ["unc", "%5C%5Chost%5Cshare%5Ca.png"], ["drive", "C%3A%5Ca.png"], ["slash", "%2Fetc%2Fhosts"]]) {
      expect(html).toContain(`<img id="${id}" src="${src}">`);
    }
    expect(html).toContain(`<script id="notjs" src="notes.txt"></script>`);
    expect(html).not.toContain("secret");
    expect(html).not.toContain("private notes");
  });

  it("resolves a page's URLs once each, and only so many", async () => {
    const root = temp();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
    writeFileSync(join(root, "a.png"), png);
    const many = Array.from({ length: 1_000 }, (_, i) => `<img src="missing-${i}.png">`).join("");
    writeFileSync(join(root, "same.html"), `${"<img src=\"missing.png\">".repeat(5_000)}<img id="last" src="a.png">`);
    writeFileSync(join(root, "many.html"), `${many}<img id="last" src="a.png">`);
    const started = performance.now();
    expect(await fileResponse(fileInfo(join(root, "same.html"))!, false, true).text()).toContain(`<img id="last" src="data:image/png;base64,`);
    expect(performance.now() - started).toBeLessThan(2_000);
    // the thousand-and-first URL is left as it is
    expect(await fileResponse(fileInfo(join(root, "many.html"))!, false, true).text()).toContain(`<img id="last" src="a.png">`);
  });

  it("refuses another site's page loading a file, but not a navigation or this app", () => {
    const ask = (headers: Record<string, string>) => crossSiteFileRead(new Request("http://localhost/api/fs/file?path=/x", { headers }));
    expect(ask({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" })).toBe(true);
    expect(ask({ "sec-fetch-site": "same-site", "sec-fetch-mode": "cors" })).toBe(true);
    // a new tab, a download or Android's PDF "Open" button is a navigation from anywhere
    expect(ask({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" })).toBe(false);
    expect(ask({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "no-cors" })).toBe(false);
    expect(ask({ "sec-fetch-site": "none", "sec-fetch-mode": "navigate" })).toBe(false);
    // a browser that sends no Fetch Metadata is let through as before
    expect(ask({})).toBe(false);
  });
});

describe("locateFile", () => {
  const roots: string[] = [];
  afterEach(() => {
    clearFileCache();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const temp = () => { const root = mkdtempSync(join(tmpdir(), "herdr-locate-")); roots.push(root); return root; };

  it("(a) opens an NFD name from absolute and relative NFC paths", async () => {
    const root = temp();
    const path = join(root, "문서.md".normalize("NFD"));
    writeFileSync(path, "# nfd");
    const distinguishes = !existsSync(join(root, "문서.md"));
    for (const found of [
      locateFile(join(root, "문서.md".normalize("NFC")), null, true),
      locateFile("문서.md", root, true),
      await fileView.findFile("문서.md", root, async () => null),
    ]) {
      expect(found).not.toBeNull();
      if (found === null || !("info" in found)) throw new Error("expected one file");
      expect(found.info.name.normalize("NFC")).toBe("문서.md");
      expect(readFileSync(found.info.path, "utf8")).toBe("# nfd");
      if (distinguishes) expect(found.info.path).toBe(path);
    }
    if (distinguishes) expect(locateFile("문서.md", root)).toBeNull();
  });

  it("(b) opens a path whose folder and filename use different forms", async () => {
    const root = temp();
    const folder = join(root, "회의자료".normalize("NFD"));
    mkdirSync(folder);
    const path = join(folder, "메모.md");
    writeFileSync(path, "mixed");
    const requested = join(root, "회의자료", "메모.md");
    for (const found of [
      locateFile(requested, null, true),
      await fileView.findFile(requested, null, async () => null),
    ]) {
      expect(found).not.toBeNull();
      if (found === null || !("info" in found)) throw new Error("expected one file");
      expect(found.info.name.normalize("NFC")).toBe("메모.md");
      expect(readFileSync(found.info.path, "utf8")).toBe("mixed");
      if (!existsSync(requested)) expect(found.info.path).toBe(path);
    }
  });

  it("(c) opens a decomposed accented Latin name", async () => {
    const root = temp();
    writeFileSync(join(root, "café.txt".normalize("NFD")), "cafe");
    const found = await fileView.findFile(join(root, "café.txt"), null, async () => null);
    expect(found).not.toBeNull();
    if (found === null || !("info" in found)) throw new Error("expected one file");
    expect(found.info.name.normalize("NFC")).toBe("café.txt");
    expect(readFileSync(found.info.path, "utf8")).toBe("cafe");
  });

  it("(d) lists sorted candidates when several forms match without an exact hit", async () => {
    const root = temp();
    const first = join(root, "가".normalize("NFD") + "나".normalize("NFD") + ".md");
    const second = join(root, "가".normalize("NFD") + "나.md");
    writeFileSync(first, "first");
    const distinguishes = !existsSync(second);
    if (distinguishes) writeFileSync(second, "second");
    const found = await fileView.findFile(join(root, "가나.md"), null, async () => null);
    if (distinguishes) expect(found).toEqual({ candidates: [first, second].sort() });
    else {
      expect(found).not.toBeNull();
      if (found === null || !("info" in found)) throw new Error("expected one file");
      expect(found.info.name.normalize("NFC")).toBe("가나.md");
      expect(readFileSync(found.info.path, "utf8")).toBe("first");
    }
  });

  it("(e) keeps exact files and directories ahead of form variants", async () => {
    const root = temp();
    const path = join(root, "문서.md");
    writeFileSync(path, "exact");
    const variant = join(root, "문서.md".normalize("NFD"));
    const distinguishes = !existsSync(variant);
    if (distinguishes) writeFileSync(variant, "variant");
    expect(await fileView.findFile(path, null, async () => null)).toMatchObject({ info: { path } });
    rmSync(path);
    mkdirSync(path);
    expect(await fileView.findFile(path, null, async () => null)).toBeNull();
    expect(locateFile(path, null, true)).toBeNull();
  });

  it("(f) resolves scratch names across forms without allowing symlink escapes", () => {
    const root = temp();
    const folder = join(root, "scratch");
    mkdirSync(folder);
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(folder, "링크.txt".normalize("NFD")));
    expect(locateFileInFolder("링크.txt", folder, true)).toBeNull();
    const path = join(folder, "문서.md".normalize("NFD"));
    writeFileSync(path, "inside");
    const found = locateFileInFolder("문서.md", folder, true);
    expect(found).not.toBeNull();
    if (found === null || !("info" in found)) throw new Error("expected one file");
    expect(found.info.name.normalize("NFC")).toBe("문서.md");
    expect(readFileSync(found.info.path, "utf8")).toBe("inside");
    if (!existsSync(join(folder, "문서.md"))) expect(locateFileInFolder("문서.md", folder)).toBeNull();
  });

  it("(g) returns null for missing ASCII names even beneath a non-ASCII folder", async () => {
    const root = temp();
    mkdirSync(join(root, "자료".normalize("NFD")));
    for (const path of [join(root, "missing.txt"), join(root, "자료", "missing.txt")]) {
      expect(locateFile(path, null, true)).toBeNull();
      expect(await fileView.findFile(path, null, async () => null)).toBeNull();
    }
  });

  it("(h) opens an exact suffix before a form variant at the pane root", async () => {
    const root = temp();
    mkdirSync(join(root, "docs"));
    const path = join(root, "docs", "문서.md");
    writeFileSync(path, "exact suffix");
    writeFileSync(join(root, "문서.md".normalize("NFD")), "variant");
    const distinguishes = !existsSync(join(root, "문서.md"));
    const found = await fileView.findFile("문서.md", root, async () => null);
    expect(found).toMatchObject({ info: { path: distinguishes ? path : join(root, "문서.md") } });
  });

  it("(i) keeps a unique exact suffix unambiguous while any-form suffixes include both", async () => {
    const root = temp();
    mkdirSync(join(root, "a"));
    mkdirSync(join(root, "b"));
    const exact = join(root, "a", "메모.md");
    const variant = "메모.md".normalize("NFD");
    writeFileSync(exact, "exact");
    writeFileSync(join(root, "b", variant), "variant");
    const distinguishes = !existsSync(join(root, "b", "메모.md"));
    const found = await fileView.findFile("메모.md", root, async () => null);
    if (distinguishes) {
      expect(found).toMatchObject({ info: { path: exact } });
      expect(filesNamed(root, "메모.md")).toEqual(["a/메모.md"]);
    } else {
      expect(found).not.toBeNull();
    }
    const matches = filesNamed(root, "메모.md", 10, true).sort();
    if (distinguishes) expect(matches).toEqual(["a/메모.md", `b/${variant}`].sort());
    else expect(matches.map((path) => path.normalize("NFC"))).toEqual(["a/메모.md", "b/메모.md"]);
  });

  it("(j) tries exact scratch files before any-form pane files and reuses the scratch lookup", async () => {
    const root = temp();
    const cwd = join(root, "pane");
    const scratch = join(root, "scratch");
    mkdirSync(cwd);
    mkdirSync(scratch);
    const panePath = join(cwd, "메모.md".normalize("NFD"));
    const scratchPath = join(scratch, "메모.md");
    writeFileSync(panePath, "pane");
    writeFileSync(scratchPath, "scratch");
    const distinguishes = !existsSync(join(cwd, "메모.md"));
    let calls = 0;
    const scratchFolder = async () => { calls += 1; return scratch; };
    expect(await fileView.findFile("메모.md", cwd, scratchFolder)).toMatchObject({
      info: { path: distinguishes ? scratchPath : join(cwd, "메모.md") },
    });
    expect(calls).toBe(distinguishes ? 1 : 0);
    rmSync(scratchPath);
    clearFileCache();
    calls = 0;
    const found = await fileView.findFile("메모.md", cwd, scratchFolder);
    expect(found).toMatchObject({ info: { path: distinguishes ? panePath : join(cwd, "메모.md") } });
    expect(calls).toBe(distinguishes ? 1 : 0);
    expect(await fileView.findFile("메모.md", cwd, async () => null)).toEqual(found);
  });

  it("refuses parent traversal outside the Claude scratch fallback folder", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-locate-")); roots.push(root);
    const folder = join(root, "session");
    mkdirSync(folder);
    writeFileSync(join(root, "outside.txt"), "outside");
    expect(locateFileInFolder("../outside.txt", folder)).toBeNull();
  });

  it("resolves an in-folder Claude scratch fallback link", () => {
    const folder = mkdtempSync(join(tmpdir(), "herdr-locate-")); roots.push(folder);
    mkdirSync(join(folder, "scratchpad"));
    const path = join(folder, "scratchpad", "notes.txt");
    writeFileSync(path, "notes");
    expect(locateFileInFolder("scratchpad/notes.txt", folder)).toMatchObject({ info: { path } });
  });

  it("refuses absolute paths and symlink escapes from the scratch fallback", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-locate-")); roots.push(root);
    const folder = join(root, "session");
    mkdirSync(folder);
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(folder, "linked.txt"));
    expect(locateFileInFolder(outside, folder)).toBeNull();
    expect(locateFileInFolder("linked.txt", folder)).toBeNull();
  });

  it("finds a bare name deeper in the pane's folder, and lists several of that name", async () => {
    const { mkdirSync } = await import("node:fs");
    const { locateFile } = await import("./file-view.ts");
    const { clearFileCache } = await import("./files.ts");
    const root = mkdtempSync(join(tmpdir(), "herdr-locate-")); roots.push(root);
    mkdirSync(join(root, "docs/screenshots"), { recursive: true });
    mkdirSync(join(root, "a"), { recursive: true });
    mkdirSync(join(root, "b"), { recursive: true });
    writeFileSync(join(root, "docs/screenshots/demo.mp4"), "x");
    writeFileSync(join(root, "a/notes.md"), "a");
    writeFileSync(join(root, "b/notes.md"), "b");
    clearFileCache();
    expect(locateFile("demo.mp4", root)).toMatchObject({ info: { path: join(root, "docs/screenshots/demo.mp4") } });
    expect(locateFile("screenshots/demo.mp4", root)).toMatchObject({ info: { name: "demo.mp4" } });
    expect(locateFile("notes.md", root)).toEqual({ candidates: [join(root, "a/notes.md"), join(root, "b/notes.md")] });
    expect(locateFile("missing.txt", root)).toBeNull();
    // an absolute or ~ path is taken as written, never searched for
    expect(locateFile("/nowhere/demo.mp4", root)).toBeNull();
  });
});
