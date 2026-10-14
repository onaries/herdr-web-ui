import { describe, expect, it } from "bun:test";

import { appendChatRowSlots, createChatRowSlots, insertChatRowSlots, prependChatRowSlots } from "./chatRows.ts";

const scope = { machineId: "local", paneId: "pane-a", historyId: "history-a", incarnation: 0 };
const keys = (rows: readonly { readonly key: string }[]) => rows.map((row) => row.key);

describe("chat row slots", () => {
  it("keeps existing keys when an older page prepends", () => {
    const newest = createChatRowSlots(scope, 2);
    const before = keys(newest.rows);

    const loaded = prependChatRowSlots(newest, 3);

    expect(keys(loaded.rows.slice(3))).toEqual(before);
    expect(new Set(keys(loaded.rows)).size).toBe(5);
  });

  it("keeps both sides stable when a held-page gap fills", () => {
    const loaded = createChatRowSlots(scope, 3);
    const before = keys(loaded.rows);

    const filled = insertChatRowSlots(loaded, 1, 2);

    expect(keys(filled.rows.slice(0, 1))).toEqual(before.slice(0, 1));
    expect(keys(filled.rows.slice(3))).toEqual(before.slice(1));
    expect(new Set(keys(filled.rows)).size).toBe(5);
  });

  it("keeps existing slots and allocates a distinct one when a new turn arrives", () => {
    const previous = createChatRowSlots(scope, 2);
    const loaded = appendChatRowSlots(previous, 1);

    expect(keys(loaded.rows.slice(0, 2))).toEqual(keys(previous.rows));
    expect(loaded.rows).toHaveLength(3);
    expect(new Set(keys(loaded.rows)).size).toBe(3);
  });

  it("does not reuse a slot when new turns arrive after a prepend", () => {
    const previous = prependChatRowSlots(createChatRowSlots(scope, 2), 3);
    const loaded = appendChatRowSlots(previous, 2);

    expect(keys(loaded.rows.slice(0, 5))).toEqual(keys(previous.rows));
    expect(new Set(keys(loaded.rows)).size).toBe(7);
  });

  it("separates replacements when the bridge supplies no history ID", () => {
    const first = createChatRowSlots({ ...scope, historyId: null }, 2);
    const replacement = createChatRowSlots({ ...scope, historyId: null, incarnation: 1 }, 2);

    expect(keys(first.rows).some((key) => keys(replacement.rows).includes(key))).toBeFalse();
  });

  it("separates machine, pane, and history identities", () => {
    const local = keys(createChatRowSlots(scope, 1).rows);
    const remote = keys(createChatRowSlots({ ...scope, machineId: "studio-mac" }, 1).rows);
    const otherPane = keys(createChatRowSlots({ ...scope, paneId: "pane-b" }, 1).rows);
    const otherHistory = keys(createChatRowSlots({ ...scope, historyId: "history-b" }, 1).rows);

    expect(local).not.toEqual(remote);
    expect(local).not.toEqual(otherPane);
    expect(local).not.toEqual(otherHistory);
  });
});
