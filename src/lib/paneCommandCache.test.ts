import { describe, expect, test } from "bun:test";

import type { SlashCommand } from "../../shared/protocol.ts";
import { cachedPaneCommands } from "./paneCommandCache.ts";

describe("cachedPaneCommands", () => {
  test("answers once a minute per PC, pane and agent, and asks again for another agent in the same pane", async () => {
    const fetched: string[] = [];
    const fetchCommands = async (pane: string): Promise<SlashCommand[]> => {
      fetched.push(pane);
      return [{ name: `cmd-${fetched.length}`, description: "", source: "builtin" }];
    };
    const first = await cachedPaneCommands("w1:p1", "local", "omo", fetchCommands);
    expect(await cachedPaneCommands("w1:p1", "local", "omo", fetchCommands)).toBe(first);
    expect(fetched).toEqual(["w1:p1"]);

    const other = await cachedPaneCommands("w1:p1", "local", "pi", fetchCommands);
    expect(other).not.toBe(first);
    expect(fetched).toEqual(["w1:p1", "w1:p1"]);
    expect(await cachedPaneCommands("w1:p1", "local", "omo", fetchCommands)).toBe(first);

    await cachedPaneCommands("w1:p1", "studio", "omo", fetchCommands);
    await cachedPaneCommands("w1:p2", "local", "omo", fetchCommands);
    expect(fetched).toEqual(["w1:p1", "w1:p1", "w1:p1", "w1:p2"]);
  });
});
