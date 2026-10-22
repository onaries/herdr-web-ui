/**
 * The demo's stand-in for two agents' own screens in their terminals: the demo's notice at the top
 * and, at the bottom, the agent's empty input row as the real one draws it (src/lib/inputRow.ts
 * reads it to bring a terminal peek back to the chat), or the screen one of its terminal commands
 * opened in its place. Escape closes that screen and draws the row again, as the agents do. Each
 * frame is one synchronized-update block, as herdr's attach stream draws it.
 *
 * Only Claude Code's /btw answer and omp's /settings and /copy have a screen here; the other
 * agents' panes keep the notice alone.
 */

/** the agents whose pane draws a screen here */
export type ScreenAgent = "claude" | "omp";

/** the commands that draw something, by agent: `open` hides the input row until Escape, `print` writes a line over it */
const COMMANDS: Record<ScreenAgent, Record<string, "open" | "print">> = {
  claude: { btw: "open" },
  omp: { settings: "open", copy: "print" },
};

export function screenAgent(agent: string): ScreenAgent | null {
  return agent === "claude" || agent === "omp" ? agent : null;
}

/** What a sent command does to the screen; null: nothing the demo draws. */
export function screenCommand(agent: ScreenAgent, name: string): "open" | "print" | null {
  return COMMANDS[agent][name] ?? null;
}

const dim = (text: string): string => `\x1b[2m${text}\x1b[22m`;
const cut = (text: string, cols: number): string => Array.from(text).slice(0, cols).join("");
/** the notice's box in the demo's amber, as the other agents' panes draw it */
const amber = (line: string): string => line.replace(/[┌┐└┘│─]+/g, (run) => `\x1b[38;5;214m${run}\x1b[39m`);

/** the rows at the bottom of the screen: the agent's empty input row, or the screen open in its place */
function bottom(agent: ScreenAgent, open: { name: string; text: string } | null, cols: number): string[] {
  if (agent === "claude") {
    if (open !== null) {
      return [` ${cut(open.text, cols - 2)}`, `  ⎿  ${cut("The demo has no model to ask: in the real app Claude answers here.", cols - 6)}`, "",
        dim(cut("  Press Space, Enter or Escape to dismiss", cols))];
    }
    const rule = "─".repeat(cols);
    return [rule, "❯ ", rule, dim(cut("  ? for shortcuts", cols))];
  }
  if (open !== null) {
    return [" Settings", ` ${"─".repeat(Math.max(0, cols - 2))}`, cut("  ▸ Model              gpt-demo", cols), cut("  ▸ Thinking           medium", cols),
      dim(cut("  ↑↓ move · enter edit · ⎋ to close", cols))];
  }
  const head = "╭── π > demo ";
  return [`${head}${"─".repeat(Math.max(0, cols - head.length - 1))}╮`, `╰─${" ".repeat(Math.max(0, cols - 4))}─╯`];
}

/**
 * One whole frame of the agent's screen for a `cols` × `rows` grid: the notice's rows (plain text,
 * cut to the grid), a printed line when there is one, and the bottom rows.
 */
export function screenFrame(agent: ScreenAgent, notice: readonly string[], printed: string | null, open: { name: string; text: string } | null, cols: number, rows: number): string {
  const lower = bottom(agent, open, cols);
  const top = [...notice, ...(printed === null ? [] : ["", cut(printed, cols)])].slice(0, Math.max(0, rows - lower.length));
  const lines = [...top.map((line, index) => index < notice.length ? amber(cut(line, cols)) : cut(line, cols)), ...Array.from({ length: Math.max(0, rows - top.length - lower.length) }, () => ""), ...lower];
  const body = lines.map((line, index) => `\x1b[${index + 1};1H\x1b[2K${line}`).join("");
  // the cursor on the input row, as the agent leaves it
  const cursor = open === null ? `\x1b[${rows - (agent === "claude" ? 2 : 1)};3H` : "";
  return `\x1b[?2026h\x1b[0m\x1b[2J${body}${cursor}\x1b[?2026l`;
}
