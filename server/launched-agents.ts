import type { AgentStatus } from "../shared/protocol.ts";
import type { RecognizedConversation } from "./conversation.ts";

/**
 * Panes this server started an agent in (New workspace, New tab, New worktree), until their
 * first turn. Most agents write no session until the first message (Codex its rollout, Claude
 * its session id, OpenCode its session row), so nothing ties such a pane to a transcript and its
 * chat would read as unavailable. The launch itself is the evidence: it resumed nothing, so the
 * conversation is one with no turns yet.
 *
 * It ends with the first turn (the agent at work or asking after it was seen at rest), with a
 * transcript found for the pane, or with the pane. Until the agent was seen at rest its status is
 * its startup's: Codex reports `working` while it draws, Claude `blocked` at its folder question.
 */
const SOURCES: Record<string, RecognizedConversation["source"]> = {
  agy: "agy-transcript", claude: "claude-transcript", codex: "codex-transcript", devin: "devin-transcript",
  gjc: "gjc-transcript", grok: "grok-transcript", hermes: "hermes-transcript", omo: "omo-transcript",
  omp: "omp-transcript", opencode: "opencode-transcript", pi: "pi-transcript",
};

/** A startup longer than this is taken for a first turn: nobody read the pane's chat while it rested. */
export const STARTUP_MS = 30_000;

interface Launch { source: RecognizedConversation["source"]; serial: number; at: number; rested: boolean }

export class LaunchedAgents {
  private readonly panes = new Map<string, Launch>();
  private serial = 0;

  /** `kind`: one this server reads a transcript of; a pane of any other keeps the terminal's fallback. */
  launched(paneId: string, kind: string, now = Date.now()): void {
    const source = Object.hasOwn(SOURCES, kind) ? SOURCES[kind] : undefined;
    if (source === undefined) { this.panes.delete(paneId); return; }
    this.serial += 1;
    this.panes.set(paneId, { source, serial: this.serial, at: now, rested: false });
  }

  /** The conversation not begun that stands for a pane no transcript was found for, or null once its first turn began. */
  notBegun(paneId: string, status: AgentStatus | undefined, now = Date.now()): { source: RecognizedConversation["source"]; historyId: string } | null {
    const launch = this.panes.get(paneId);
    if (launch === undefined) return null;
    const busy = status === "working" || status === "blocked";
    if (!busy && (status === "idle" || status === "done")) launch.rested = true;
    if (busy && (launch.rested || now - launch.at > STARTUP_MS)) { this.panes.delete(paneId); return null; }
    return { source: launch.source, historyId: `unwritten:launch:${paneId}:${launch.serial}` };
  }

  /**
   * The status to take for one herdr read off the pane. Before the first turn there is no work and
   * no finish: an agent drawing its start screen reads `working` and then `done` (Codex, live
   * 2026-10-14), which showed DONE on a pane nobody had asked anything of. A question it asks
   * (Claude's folder question) is a question all the same.
   */
  settle(paneId: string, status: AgentStatus, now = Date.now()): AgentStatus {
    const unbegun = this.notBegun(paneId, status, now) !== null;
    return unbegun && (status === "working" || status === "done") ? "idle" : status;
  }

  forget(paneId: string): void { this.panes.delete(paneId); }
  clear(): void { this.panes.clear(); }
}

export const launchedAgents = new LaunchedAgents();
