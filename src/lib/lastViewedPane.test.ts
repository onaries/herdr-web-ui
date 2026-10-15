import { describe, expect, test } from "bun:test";
import { parseViewedPanes, viewedPanes, withViewedPane } from "./lastViewedPane.ts";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const items = new Map<string, string>();
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => { items.set(key, value); } };
}

describe("last viewed pane", () => {
  test("a stored list reads back in order, and anything malformed is dropped", () => {
    expect([...parseViewedPanes(JSON.stringify([["workspace:local:w1", "w1:p2"], ["tab:local:w1:t1", "w1:p2"]]))])
      .toEqual([["workspace:local:w1", "w1:p2"], ["tab:local:w1:t1", "w1:p2"]]);
    expect([...parseViewedPanes(JSON.stringify([["workspace:local:w1", 3], ["only one"], "w1:p1", ["workspace:local:w2", "w2:p1"]]))])
      .toEqual([["workspace:local:w2", "w2:p1"]]);
    expect(parseViewedPanes("{not json").size).toBe(0);
    expect(parseViewedPanes(JSON.stringify({ "workspace:local:w1": "w1:p1" })).size).toBe(0);
    expect(parseViewedPanes(null).size).toBe(0);
  });

  test("a view moves its entry to the end and replaces the pane it had", () => {
    const start = new Map([["workspace:local:w1", "w1:p1"], ["workspace:local:w2", "w2:p1"]]);
    const next = withViewedPane(start, "workspace:local:w1", "w1:p2");
    expect([...next]).toEqual([["workspace:local:w2", "w2:p1"], ["workspace:local:w1", "w1:p2"]]);
    expect(start.get("workspace:local:w1")).toBe("w1:p1");
  });

  test("past the limit the oldest entries go", () => {
    let entries = new Map<string, string>();
    for (let index = 0; index < 5; index++) entries = withViewedPane(entries, `workspace:local:w${index}`, `w${index}:p1`, 3);
    expect([...entries.keys()]).toEqual(["workspace:local:w2", "workspace:local:w3", "workspace:local:w4"]);
  });

  test("a second app tab keeps the first tab's entry when both write", () => {
    const storage = memoryStorage();
    const first = viewedPanes(() => storage);
    const second = viewedPanes(() => storage);
    expect(second.get("tab", "local", "t1")).toBeUndefined();
    first.remember("tab", "local", "t1", "w1:p2");
    second.remember("workspace", "local", "w2", "w2:p3");
    expect(viewedPanes(() => storage).get("tab", "local", "t1")).toBe("w1:p2");
    expect(viewedPanes(() => storage).get("workspace", "local", "w2")).toBe("w2:p3");
    first.forget();
    expect(first.get("workspace", "local", "w2")).toBe("w2:p3");
  });

  test("an entry seen again on the same pane is kept over older ones at the limit", () => {
    const storage = memoryStorage();
    const panes = viewedPanes(() => storage);
    for (let index = 0; index < 200; index++) panes.remember("tab", "local", `t${index}`, `p${index}`);
    panes.remember("tab", "local", "t0", "p0");
    panes.remember("tab", "local", "t200", "p200");
    const stored = viewedPanes(() => storage);
    expect(stored.get("tab", "local", "t0")).toBe("p0");
    expect(stored.get("tab", "local", "t1")).toBeUndefined();
    expect(stored.get("tab", "local", "t200")).toBe("p200");
  });

  test("storage that cannot be used keeps the entries in memory", () => {
    const panes = viewedPanes(() => { throw new Error("denied"); });
    panes.remember("workspace", "local", "w1", "w1:p2");
    expect(panes.get("workspace", "local", "w1")).toBe("w1:p2");
    const full = viewedPanes(() => ({ getItem: () => null, setItem: () => { throw new Error("quota"); } }));
    full.remember("tab", "local", "t1", "w1:p2");
    full.remember("tab", "local", "t2", "w1:p3");
    expect(full.get("tab", "local", "t1")).toBe("w1:p2");
  });
});
