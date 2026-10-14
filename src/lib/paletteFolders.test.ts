import { describe, expect, test } from "bun:test";

import { browseEntries, folderQuery, folderQueryFor, matchFolders, pinnedFolders, requestFilesFolder, subscribeFilesFolder, takeFilesFolder } from "./paletteFolders.ts";

describe("folderQuery", () => {
  test("a pane or action search is no folder", () => {
    expect(folderQuery("")).toBeNull();
    expect(folderQuery("claude")).toBeNull();
    expect(folderQuery(">theme")).toBeNull();
    expect(folderQuery("~foo")).toBeNull();
  });

  test("splits the folder from the filter after its last slash", () => {
    expect(folderQuery("~")).toEqual({ directory: "~", filter: "" });
    expect(folderQuery("~/")).toEqual({ directory: "~", filter: "" });
    expect(folderQuery("~/wo")).toEqual({ directory: "~", filter: "wo" });
    expect(folderQuery("~/work/her")).toEqual({ directory: "~/work", filter: "her" });
    expect(folderQuery("~/work/")).toEqual({ directory: "~/work", filter: "" });
    expect(folderQuery("/")).toEqual({ directory: "/", filter: "" });
    expect(folderQuery("/us")).toEqual({ directory: "/", filter: "us" });
    expect(folderQuery("/usr/lo")).toEqual({ directory: "/usr", filter: "lo" });
  });

  test("a Windows drive keeps its root", () => {
    expect(folderQuery("C:\\")).toEqual({ directory: "C:/", filter: "" });
    expect(folderQuery("C:\\Users\\de")).toEqual({ directory: "C:/Users", filter: "de" });
  });
});

describe("folderQueryFor", () => {
  test("home-relative with a trailing slash", () => {
    expect(folderQueryFor("/home/me/work", "/home/me")).toBe("~/work/");
    expect(folderQueryFor("/home/me", "/home/me")).toBe("~/");
    expect(folderQueryFor("/srv", "/home/me")).toBe("/srv/");
    expect(folderQueryFor("/", "/home/me")).toBe("/");
    expect(folderQueryFor("/srv/app", null)).toBe("/srv/app/");
  });
});

describe("browseEntries", () => {
  const names = [".config", "Code", "code-old", "docs", "work"];

  test("filters by the start of the name in any case and hides dot-folders", () => {
    expect(browseEntries(names, "")).toEqual(["Code", "code-old", "docs", "work"]);
    expect(browseEntries(names, "co")).toEqual(["Code", "code-old"]);
    expect(browseEntries(names, "ork")).toEqual([]);
  });

  test("a leading dot shows the dot-folders", () => {
    expect(browseEntries(names, ".")).toEqual([".config"]);
  });

  test("the folder the filter names exactly comes first", () => {
    expect(browseEntries(["code-new", "code"], "code")).toEqual(["code", "code-new"]);
  });
});

describe("pinnedFolders", () => {
  test("the folders of this PC's pinned panes, in pin order, once each", () => {
    const panes = [
      { pane_id: "p1", cwd: "/home/me/a" },
      { pane_id: "p2", cwd: "/home/me/b", foreground_cwd: "/home/me/b/src" },
      { pane_id: "p3", cwd: "/home/me/a" },
      { pane_id: "p4", cwd: null },
    ];
    expect(pinnedFolders(["local:p2", "other:p1", "local:p1", "local:p3", "local:p4", "local:gone"], "local", panes)).toEqual(["/home/me/b/src", "/home/me/a"]);
  });
});

describe("matchFolders", () => {
  const paths = ["/home/me/work/herdr", "/home/me/Work/app", "/srv/data", "/home/me/work"];

  test("matches the typed path by its absolute or home form, any case", () => {
    expect(matchFolders(paths, "~/", "/home/me", 10)).toEqual(["/home/me/work/herdr", "/home/me/Work/app", "/home/me/work"]);
    expect(matchFolders(paths, "~/work/h", "/home/me", 10)).toEqual(["/home/me/work/herdr"]);
    expect(matchFolders(paths, "/s", "/home/me", 10)).toEqual(["/srv/data"]);
    expect(matchFolders(paths, "/home/me/w", null, 10)).toEqual(["/home/me/work/herdr", "/home/me/Work/app", "/home/me/work"]);
  });

  test("leaves out the folder listed and caps the list", () => {
    expect(matchFolders(paths, "~/work/", "/home/me", 10)).toEqual(["/home/me/work/herdr", "/home/me/Work/app"]);
    expect(matchFolders(paths, "~/", "/home/me", 1)).toEqual(["/home/me/work/herdr"]);
  });
});

describe("Files folder request", () => {
  test("taken once, and heard by an open Files", () => {
    expect(takeFilesFolder()).toBeNull();
    const heard: (string | null)[] = [];
    const stop = subscribeFilesFolder(() => heard.push(takeFilesFolder()));
    requestFilesFolder("/home/me/work");
    stop();
    expect(heard).toEqual(["/home/me/work"]);
    requestFilesFolder("/srv");
    expect(takeFilesFolder()).toBe("/srv");
    expect(takeFilesFolder()).toBeNull();
  });
});
