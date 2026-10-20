import type { AgentCommandSource } from "./index.ts";

// dsh-tui 0.16.1, lib/types/commands.js LOCAL_COMMANDS (DSH kernel).
// shortcut: local commands only; add registry/skill discovery when its live catalog is exposed.
const descriptions: Record<string, string> = {
  new: "Start a new conversation", clear: "Clear the conversation", compact: "Summarize earlier turns to free context space",
  resume: "Continue a saved session", rename: "Rename the current session", recap: "Generate a recap of recent session activity",
  rewind: "Return the session to an earlier message", tree: "Browse the session family tree", fork: "Fork the current session into a resumable copy",
  export: "Save the session as Markdown", btw: "Ask a quick side question without interrupting the conversation", trace: "Show the session event trace timeline",
  agentview: "Open the agent view", bg: "Open the session manager and background this session", background: "Alias of /bg",
  context: "Show loaded context details", status: "Show session status", cost: "Show session token usage",
  config: "Show the dsh-tui configuration source", reload: "Reload preference files and apply live", settings: "View and edit plugin settings",
  setup: "Re-run the first-run guide", star: "Star dsh-tui on GitHub", doctor: "Run environment checks",
  migrate: "Import conversations from other coding agents", init: "Create AGENTS.md in the working directory", agents: "Show subagents of this session",
  team: "Show or switch Agent Teams", jobs: "Show background jobs of this session", panel: "Toggle, focus or switch side panels",
  activity: "Switch the working indicator preset", preset: "Switch the agent preset", theme: "Switch the color theme",
  color: "Set the current session accent color", lang: "Switch the UI language", model: "Show the active model",
  effort: "Adjust reasoning effort", thinking: "Toggle extended thinking display", tokens: "Show session token usage",
  balance: "Show DeepSeek account balance", provider: "Manage LLM providers", login: "Show API credential status",
  logout: "Clear the API credential", "add-dir": "Show the filesystem policy scope", hooks: "Show hooks status",
  mcp: "Show MCP status", skills: "List available skills", plugin: "Show plugin diagnostics and profile plugins",
  update: "Update dsh-tui and restart", vim: "Toggle Vim keybindings", "terminal-setup": "Show terminal setup instructions",
  connect: "Connect to a remote machine", workspace: "Resume, rename or open a workspace", home: "Manage workspaces and sessions",
  help: "Show shortcuts and commands", tips: "Show usage tips and shortcuts", kernel: "Choose the DSH, Codex or Claude kernel",
  dsh: "Switch to the DSH kernel with a new session", codex: "Switch to the Codex kernel with a new session", claude: "Switch to the Claude kernel with a new session",
  restart: "Restart dsh-tui and resume this session", exit: "Exit dsh-tui", quit: "Alias of /exit", q: "Alias of /exit",
};

export const source: AgentCommandSource = {
  pin: "0.16.1",
  builtins: Object.keys(descriptions),
  descriptions,
  discover: () => [],
};
