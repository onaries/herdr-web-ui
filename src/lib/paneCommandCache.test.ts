import { describe, expect, test } from "bun:test";

import type { SlashCommand } from "../../shared/protocol.ts";
import { cachedPaneCommands, invalidatePaneCommands, onPaneCommandsInvalidated } from "./paneCommandCache.ts";

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

  test("an invalidated pane asks again for every agent, tells its listeners, and leaves other panes cached", async () => {
    const fetched: string[] = [];
    const fetchCommands = async (pane: string): Promise<SlashCommand[]> => {
      fetched.push(pane);
      return [{ name: `cmd-${fetched.length}`, description: "", source: "builtin" }];
    };
    const omo = await cachedPaneCommands("w2:p1", "local", "omo", fetchCommands);
    const pi = await cachedPaneCommands("w2:p1", "local", "pi", fetchCommands);
    const other = await cachedPaneCommands("w2:p2", "local", "omo", fetchCommands);
    const told: string[] = [];
    const stop = onPaneCommandsInvalidated((paneId, machineId) => { told.push(`${machineId}/${paneId}`); });
    invalidatePaneCommands("w2:p1", "local");
    expect(told).toEqual(["local/w2:p1"]);
    expect(await cachedPaneCommands("w2:p1", "local", "omo", fetchCommands)).not.toBe(omo);
    expect(await cachedPaneCommands("w2:p1", "local", "pi", fetchCommands)).not.toBe(pi);
    expect(await cachedPaneCommands("w2:p2", "local", "omo", fetchCommands)).toBe(other);
    expect(fetched).toEqual(["w2:p1", "w2:p1", "w2:p2", "w2:p1", "w2:p1"]);
    stop();
    invalidatePaneCommands("w2:p1", "local");
    expect(told).toEqual(["local/w2:p1"]);
  });

  test("a read begun before an invalidation is answered but never kept over the read begun after it", async () => {
    const resolvers: ((commands: SlashCommand[]) => void)[] = [];
    const fetchCommands = (): Promise<SlashCommand[]> => new Promise((resolve) => { resolvers.push(resolve); });
    const stale = cachedPaneCommands("w3:p1", "local", "omo", fetchCommands);
    invalidatePaneCommands("w3:p1", "local");
    const fresh = cachedPaneCommands("w3:p1", "local", "omo", fetchCommands);
    expect(resolvers.length).toBe(2);
    const freshRows: SlashCommand[] = [{ name: "fresh", description: "", source: "builtin" }];
    resolvers[1]!(freshRows);
    expect(await fresh).toBe(freshRows);
    const staleRows: SlashCommand[] = [{ name: "stale", description: "", source: "builtin" }];
    resolvers[0]!(staleRows);
    expect(await stale).toBe(staleRows);
    // the list the catalog change made is what the pane keeps for the next minute
    expect(await cachedPaneCommands("w3:p1", "local", "omo", fetchCommands)).toBe(freshRows);
    expect(resolvers.length).toBe(2);
  });
});
