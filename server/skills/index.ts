import type { SlashCommand } from "../../shared/protocol.ts";
import { source as omo } from "./omo.ts";
import { source as claude } from "./claude.ts";
import { source as codex } from "./codex.ts";
import { source as pi } from "./pi.ts";
import { source as omp } from "./omp.ts";
import { source as gjc } from "./gjc.ts";
import { source as opencode } from "./opencode.ts";
import { source as devin } from "./devin.ts";
import { source as grok } from "./grok.ts";
import { source as hermes } from "./hermes.ts";
import { source as agy } from "./agy.ts";

export interface ProcessRoots {
  readonly agentDir?: string | null;
  readonly pluginDir?: string | null;
  readonly environ?: readonly string[] | null;
}
export interface AgentCommandContext {
  readonly home: string;
  readonly cwd: string | null | undefined;
  readonly repoRoot: string | null;
  readonly env: readonly string[] | null;
  readonly roots: ProcessRoots;
}
export interface AgentCommandSource {
  readonly builtins: readonly string[];
  readonly descriptions?: Readonly<Record<string, string>>;
  readonly discover: (ctx: AgentCommandContext) => SlashCommand[];
}
export const AGENT_SOURCES: Record<string, AgentCommandSource> = { omo, claude, codex, pi, omp, gjc, opencode, devin, grok, hermes, agy };
