import { describe, expect, it } from "bun:test";
import type { SessionSnapshot } from "../../shared/protocol.ts";
import { ComposerDraftStore } from "./composerDraft.ts";
import { carryPaneRecords, moveRefusal, paneMoveTargets } from "./paneMove.ts";
import { readTerminalDraft, setTerminalDraftSending, writeTerminalDraft } from "./terminalDraft.ts";

const t = (key: string, vars?: Record<string, string | number>): string => key.replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? ""));

const snapshot = {
  workspaces: [
    { workspace_id: "w1", label: "api" },
    { workspace_id: "w2", label: "docs" },
    { workspace_id: "w3", label: "infra" },
  ],
  tabs: [
    { tab_id: "w1:t2", workspace_id: "w1", label: "", number: 2 },
    { tab_id: "w1:t1", workspace_id: "w1", label: "build", number: 1 },
    { tab_id: "w1:t3", workspace_id: "w1", label: "", number: 3 },
    { tab_id: "w2:t1", workspace_id: "w2", label: "", number: 1 },
  ],
} as unknown as Pick<SessionSnapshot, "tabs" | "workspaces">;

describe("paneMoveTargets", () => {
  it("lists a new tab, the workspace's other tabs in order, every other workspace, then a new workspace", () => {
    const targets = paneMoveTargets(snapshot, { workspace_id: "w1", tab_id: "w1:t2" }, t);
    expect(targets.map((target) => [target.id, target.label, target.divider ?? false])).toEqual([
      ["new-tab", "New tab", false],
      ["tab:w1:t1", "build", false],
      ["tab:w1:t3", "Tab 3", false],
      ["workspace:w2", "docs", true],
      ["workspace:w3", "infra", false],
      ["new-workspace", "New workspace", true],
    ]);
    expect(targets.map((target) => target.destination)).toEqual([
      { type: "new_tab" },
      { type: "tab", tab_id: "w1:t1" },
      { type: "tab", tab_id: "w1:t3" },
      { type: "new_tab", workspace_id: "w2" },
      { type: "new_tab", workspace_id: "w3" },
      { type: "new_workspace" },
    ]);
  });

  it("names tabs by their place in the strip after a reorder, so a numeric custom name is not mistaken for another tab", () => {
    // herdr keeps each tab's number when tabs are reordered: "2" named by the user now sits first
    const reordered = {
      workspaces: snapshot.workspaces,
      tabs: [
        { tab_id: "w1:tb", workspace_id: "w1", label: "2", number: 3 },
        { tab_id: "w1:ta", workspace_id: "w1", label: "", number: 1 },
        { tab_id: "w1:tc", workspace_id: "w1", label: "", number: 2 },
      ],
    } as unknown as Pick<SessionSnapshot, "tabs" | "workspaces">;
    const labels = paneMoveTargets(reordered, { workspace_id: "w1", tab_id: "w1:tc" }, t).filter((target) => target.kind === "tab").map((target) => [target.id, target.label]);
    expect(labels).toEqual([["tab:w1:tb", "2"], ["tab:w1:ta", "Tab 2"]]);
  });

  it("offers a lone pane a new tab and the other workspaces only", () => {
    const targets = paneMoveTargets(snapshot, { workspace_id: "w2", tab_id: "w2:t1" }, t);
    expect(targets.map((target) => target.id)).toEqual(["new-tab", "workspace:w1", "workspace:w3", "new-workspace"]);
  });
});

describe("carryPaneRecords", () => {
  const fakeStorage = (entries: Record<string, string>) => {
    const data = new Map(Object.entries(entries));
    return { data, storage: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } } };
  };

  it("moves the lens, the terminal draft and the composer draft to the new id", () => {
    const { data, storage } = fakeStorage({
      "herdr-web-ui:view:w1:p1": "chat",
      "herdr-web-ui:terminal-draft:w1:p1": JSON.stringify({ text: "ls", at: 1 }),
      "herdr-web-ui:composer-draft:w1:p1": "half a message",
      "herdr-web-ui:queue:w1:p1": "held",
    });
    const drafts = new ComposerDraftStore(() => storage);
    carryPaneRecords("local", "w1:p1", "w2:p3", { storage: () => storage, drafts });
    expect(data.get("herdr-web-ui:view:w2:p3")).toBe("chat");
    expect(data.get("herdr-web-ui:terminal-draft:w2:p3")).toBe(JSON.stringify({ text: "ls", at: 1 }));
    expect(data.get("herdr-web-ui:composer-draft:w2:p3")).toBe("half a message");
    expect(drafts.read("herdr-web-ui:composer-draft:w2:p3").text).toBe("half a message");
    expect(data.has("herdr-web-ui:view:w1:p1")).toBe(false);
    expect(data.has("herdr-web-ui:terminal-draft:w1:p1")).toBe(false);
    expect(data.has("herdr-web-ui:composer-draft:w1:p1")).toBe(false);
    expect(data.get("herdr-web-ui:queue:w1:p1")).toBe("held");
  });

  it("moves the phone's terminal line too, and leaves one that is being sent", () => {
    const { storage } = fakeStorage({});
    const drafts = new ComposerDraftStore(() => storage);
    writeTerminalDraft("w1:p1", "ls -la");
    carryPaneRecords("local", "w1:p1", "w2:p3", { storage: () => storage, drafts });
    expect(readTerminalDraft("w2:p3")).toBe("ls -la");
    expect(readTerminalDraft("w1:p1")).toBe("");
    // on its way: the acknowledgement clears it under the owner that sent it
    writeTerminalDraft("w3:p1", "make");
    setTerminalDraftSending("w3:p1", true);
    carryPaneRecords("local", "w3:p1", "w4:p1", { storage: () => storage, drafts });
    expect(readTerminalDraft("w3:p1")).toBe("make");
    expect(readTerminalDraft("w4:p1")).toBe("");
    setTerminalDraftSending("w3:p1", false);
    writeTerminalDraft("w3:p1", "");
    writeTerminalDraft("w2:p3", "");
  });

  it("leaves a draft another tab is sending, read through its lease", () => {
    // the sidebar's move never opened the composer here: this tab's store has not read the draft
    const { data, storage } = fakeStorage({ "herdr-web-ui:composer-draft:w1:p1": "on its way" });
    const otherTab = new ComposerDraftStore(() => storage);
    expect(otherTab.begin("herdr-web-ui:composer-draft:w1:p1", "on its way")).toBe(true);
    const thisTab = new ComposerDraftStore(() => storage);
    carryPaneRecords("local", "w1:p1", "w2:p1", { storage: () => storage, drafts: thisTab });
    expect(data.get("herdr-web-ui:composer-draft:w1:p1")).toBe("on its way");
    expect(data.has("herdr-web-ui:composer-draft:w2:p1")).toBe(false);
    expect(thisTab.read("herdr-web-ui:composer-draft:w2:p1").text).toBe("");
  });

  it("keeps a remote pane's namespace and leaves a draft that is being sent", () => {
    const { data, storage } = fakeStorage({ "herdr-web-ui:view:remote:pc:w1%3Ap1": "terminal", "herdr-web-ui:composer-draft:remote:pc:w1%3Ap1": "on its way" });
    const drafts = new ComposerDraftStore(() => storage);
    expect(drafts.begin("herdr-web-ui:composer-draft:remote:pc:w1%3Ap1", "on its way")).toBe(true);
    carryPaneRecords("pc", "w1:p1", "w2:p1", { storage: () => storage, drafts });
    expect(data.get("herdr-web-ui:view:remote:pc:w2%3Ap1")).toBe("terminal");
    expect(data.get("herdr-web-ui:composer-draft:remote:pc:w1%3Ap1")).toBe("on its way");
    expect(data.has("herdr-web-ui:composer-draft:remote:pc:w2%3Ap1")).toBe(false);
  });

  it("does nothing when the id stayed", () => {
    const { data, storage } = fakeStorage({ "herdr-web-ui:view:w1:p1": "chat" });
    carryPaneRecords("local", "w1:p1", "w1:p1", { storage: () => storage, drafts: new ComposerDraftStore(() => storage) });
    expect([...data.keys()]).toEqual(["herdr-web-ui:view:w1:p1"]);
  });
});

describe("moveRefusal", () => {
  it("says what to do about a zoomed tab, names a pane already in place, and passes an unknown reason on", () => {
    expect(moveRefusal("zoomed_tab", t)).toBe("the tab is zoomed; unzoom it in herdr, then move the pane");
    expect(moveRefusal("same_tab", t)).toBe("the pane is already in that tab");
    expect(moveRefusal("locked_layout", t)).toBe("locked_layout");
    expect(moveRefusal(null, t)).toBe("herdr left the pane where it was");
    expect(moveRefusal(undefined, t)).toBe("herdr left the pane where it was");
  });
});
