import { beforeEach, describe, expect, it } from "bun:test";

import { faviconKey, faviconPath, forgetFaviconProbes, probeFavicon } from "./projectFavicon.ts";

describe("project favicon probe", () => {
  beforeEach(forgetFaviconProbes);

  it("returns the first candidate that is an image, trying them in order", async () => {
    const asked: string[] = [];
    const found = await probeFavicon("k", "/work/app/", async (path) => { asked.push(path); return path.endsWith("public/favicon.ico"); });
    expect(found).toBe("/work/app/public/favicon.ico");
    expect(asked).toEqual(["/work/app/favicon.svg", "/work/app/favicon.ico", "/work/app/favicon.png", "/work/app/public/favicon.svg", "/work/app/public/favicon.ico"]);
  });

  it("answers null when nothing is found, and a failing check counts as not found", async () => {
    expect(await probeFavicon("k", "/x", async () => { throw new Error("404"); })).toBeNull();
  });

  it("asks again after a miss whose check failed", async () => {
    let calls = 0;
    expect(await probeFavicon("k", "/x", async () => { calls += 1; throw new Error("offline"); })).toBeNull();
    const after = calls;
    expect(await probeFavicon("k", "/x", async (path) => { calls += 1; return path === "/x/favicon.ico"; })).toBe("/x/favicon.ico");
    expect(calls).toBeGreaterThan(after);
  });

  it("probes a folder once, remembering a miss too", async () => {
    let calls = 0;
    const check = async () => { calls += 1; return false; };
    await probeFavicon("k", "/x", check);
    const after = calls;
    expect(await probeFavicon("k", "/x", check)).toBeNull();
    expect(calls).toBe(after);
    await probeFavicon(faviconKey("pc2", "/x"), "/x", check);
    expect(calls).toBe(after * 2);
  });

  it("builds absolute paths", () => {
    expect(faviconPath("/a/b//", "favicon.svg")).toBe("/a/b/favicon.svg");
  });
});
