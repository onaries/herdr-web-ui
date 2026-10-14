import { paneStorageId } from "../../shared/machines.ts";
import type { SlashCommand } from "../../shared/protocol.ts";

const COMMAND_CACHE_MS = 60_000;
const cache = new Map<string, { loadedAt: number; commands: SlashCommand[] }>();

/** A pane's slash commands, asked for at most once a minute per PC and pane: the composer's menu and the chat's skill chips read the same answer. */
export async function cachedPaneCommands(paneId: string, machineId: string, fetchCommands: (pane: string) => Promise<SlashCommand[]>): Promise<SlashCommand[]> {
  const key = paneStorageId(machineId, paneId);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.loadedAt < COMMAND_CACHE_MS) return cached.commands;
  const commands = await fetchCommands(paneId);
  cache.set(key, { loadedAt: Date.now(), commands });
  return commands;
}
