import type { SlashCommand } from "../../shared/protocol.ts";

/**
 * The text a Compact click sends, or null when the pane's agent does not list a `/compact`
 * command (its `/api/pane/commands` answer): the control is drawn only where it can work.
 */
export function compactCommandText(commands: readonly SlashCommand[]): string | null {
  const found = commands.some((command) => command.name === "compact" && (command.trigger ?? "/") === "/");
  return found ? "/compact" : null;
}
