/**
 * The fictional session behind the README media (scripts/readme-media/stage.ts) and the browser
 * demo (site/demo/transport.ts): two repositories with two agent worktrees each, a shell tab, their
 * curated chats and one Codex approval. Nothing here comes from a real machine. It imports no server
 * code, so the browser bundle can take it.
 */
import type { ConversationTurn, InteractivePrompt } from "../../shared/protocol.ts";

export interface DemoSpec {
  key: string;
  /** the workspace's label and the folder name: under the demo root, or under herdr's worktrees folder */
  label: string;
  /** the pane's title */
  title: string;
  agent: string | null;
  state?: "idle" | "working" | "blocked";
  /** a linked worktree of this repository spec's key, checked out on `branch` */
  worktreeOf?: string;
  branch?: string;
  /** a second tab, labelled `label`, in this spec's workspace instead of a workspace of its own */
  tabOf?: string;
}

// The sidebar reads as two repositories, each with its own agent and two agent worktrees under it.
export const SPECS: DemoSpec[] = [
  { key: "api", label: "checkout-api", title: "Idempotent payments", agent: "claude", state: "working" },
  { key: "web", label: "export-guard", title: "Guard the export button", agent: "codex", state: "blocked", worktreeOf: "api", branch: "feat/export-guard" },
  { key: "flaky", label: "flaky-retry-test", title: "Fix the flaky retry test", agent: "claude", state: "idle", worktreeOf: "api", branch: "fix/flaky-retry-test" },
  { key: "omp", label: "cli-tools", title: "Plan the config file", agent: "omp", state: "idle" },
  { key: "cli", label: "retry-flag", title: "Ship the retry flag", agent: "pi", state: "idle", worktreeOf: "omp", branch: "feat/retry-flag" },
  { key: "hermes", label: "changelog", title: "Draft the changelog", agent: "hermes", state: "idle", worktreeOf: "omp", branch: "docs/changelog" },
  { key: "shell", label: "release", title: "Tag v1.4.0", agent: null, tabOf: "api" },
];

export const t = (min: number, sec = 0) => `2026-09-25T09:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}.000Z`;
const tool = (name: string, summary: string, input: unknown, output: string): ConversationTurn["parts"][number] => ({ kind: "tool", name, summary, input: typeof input === "string" ? input : JSON.stringify(input, null, 2), output });

export const CHATS: Record<string, { turns: ConversationTurn[]; metadata: { model: string; reasoning_effort: string } }> = {
  api: {
    metadata: { model: "claude-opus-5-5", reasoning_effort: "high" },
    turns: [
      { role: "user" as const, ts: t(2), parts: [{ kind: "text" as const, text: "Make `POST /payments` idempotent: a client retrying with the same `Idempotency-Key` must get the first response back, never a second charge. Cover it with tests." }] },
      { role: "assistant" as const, ts: t(2, 5), end_ts: t(4, 41), parts: [
        { kind: "text" as const, text: "I'll look at how payments are created and where a key could be stored." },
        tool("Grep", "Idempotency-Key", { pattern: "Idempotency-Key", path: "src" }, "src/routes/payments.ts:14: // TODO: honour Idempotency-Key"),
        tool("Read", "src/routes/payments.ts", { file_path: "src/routes/payments.ts" }, "export async function createPayment(req: Request) { … }"),
        tool("Edit", "src/routes/payments.ts", { file_path: "src/routes/payments.ts" }, "Updated src/routes/payments.ts"),
        tool("Write", "src/lib/idempotency.ts", { file_path: "src/lib/idempotency.ts" }, "Created src/lib/idempotency.ts"),
        tool("Bash", "bun test payments", { command: "bun test payments" }, " 14 pass\n 0 fail\nRan 14 tests across 2 files. [412ms]"),
        { kind: "text" as const, text: "Done. Retries are now safe:\n\n- **`src/lib/idempotency.ts`** stores the first response per key for 24 h, scoped to the API client, so two clients can reuse a key without colliding.\n- **`POST /payments`** replays the stored response for a repeated key, and answers `409` while the first request with that key is still in flight.\n- A repeated key with a **different body** is rejected with `422`, instead of silently returning the old payment.\n\n```ts\nconst cached = await idempotency.lookup(client.id, key, body);\nif (cached) return cached.response;\n```\n\nTests: 14 pass, including concurrent retries and a key reused with a changed amount. See https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/ for the header's semantics." },
      ] },
      { role: "user" as const, ts: t(6), parts: [{ kind: "text" as const, text: "Nice. Now add a metric for replayed requests." }] },
      { role: "assistant" as const, ts: t(6, 3), parts: [
        { kind: "text" as const, text: "Adding a `payments_idempotent_replays_total` counter next to the existing request metrics." },
        tool("Read", "src/metrics.ts", { file_path: "src/metrics.ts" }, "export const requests = new Counter({ … })"),
        tool("Edit", "src/metrics.ts", { file_path: "src/metrics.ts" }, "Updated src/metrics.ts"),
      ] },
    ],
  },
  web: {
    metadata: { model: "gpt-5.6-sol", reasoning_effort: "medium" },
    turns: [
      { role: "user" as const, ts: t(1), parts: [{ kind: "text" as const, text: "Rate-limit the export button so a double click can't start two exports, then push the branch." }] },
      { role: "assistant" as const, ts: t(1, 4), end_ts: t(3, 20), parts: [
        tool("exec", "rg -n \"startExport\" src", { cmd: "rg -n \"startExport\" src" }, "src/pages/Reports.tsx:88:  onClick={() => startExport(filters)}"),
        tool("apply_patch", "src/pages/Reports.tsx", "*** Begin Patch\n*** Update File: src/pages/Reports.tsx\n@@\n-  onClick={() => startExport(filters)}\n+  disabled={exporting}\n+  onClick={() => { if (!exporting) startExport(filters); }}\n*** End Patch", "Success. Updated the following files:\nM src/pages/Reports.tsx"),
        tool("exec", "pnpm test --filter reports", { cmd: "pnpm test --filter reports" }, "✓ 9 tests passed"),
        { kind: "text" as const, text: "The button is disabled while an export runs, and a second click within the same run is ignored. Tests pass; I need your OK to push `feat/export-guard`." },
      ] },
    ],
  },
  flaky: {
    metadata: { model: "claude-opus-5-5", reasoning_effort: "high" },
    turns: [
      { role: "user" as const, ts: t(7), parts: [{ kind: "text" as const, text: "`retries a timed-out upload` fails about one run in ten. Find out why and fix it." }] },
      { role: "assistant" as const, ts: t(7, 4), end_ts: t(9, 30), parts: [
        tool("Read", "src/lib/retry.test.ts", { file_path: "src/lib/retry.test.ts" }, "test(\"retries a timed-out upload\", async () => { … })"),
        tool("Bash", "bun test retry --rerun-each 50", { command: "bun test retry --rerun-each 50" }, " 46 pass\n 4 fail\nexpected 3 attempts, received 2"),
        tool("Edit", "src/lib/retry.test.ts", { file_path: "src/lib/retry.test.ts" }, "Updated src/lib/retry.test.ts"),
        tool("Bash", "bun test retry --rerun-each 50", { command: "bun test retry --rerun-each 50" }, " 50 pass\n 0 fail"),
        { kind: "text" as const, text: "The test waited on the real clock, so a slow run let the backoff timer fire before the second attempt was counted. It now drives the timer with a fake clock: 50 runs out of 50 pass." },
      ] },
    ],
  },
  omp: {
    metadata: { model: "anthropic/claude-opus-5-5", reasoning_effort: "high" },
    turns: [
      { role: "user" as const, ts: t(3), parts: [{ kind: "text" as const, text: "Plan a `cli-tools.toml` so the flags people repeat can live in a file." }] },
      { role: "assistant" as const, ts: t(3, 4), end_ts: t(5, 10), parts: [
        tool("bash", "rg -n \"option\\(\" src/cli.ts", { command: "rg -n \"option\\(\" src/cli.ts" }, "src/cli.ts:12:  .option(\"--retries <n>\")\nsrc/cli.ts:13:  .option(\"--registry <url>\")\nsrc/cli.ts:14:  .option(\"--dry-run\")"),
        { kind: "text" as const, text: "Three steps:\n\n1. Read `cli-tools.toml` from the project root, then `~/.config/cli-tools.toml`.\n2. A flag on the command line wins over the file, the file over the defaults.\n3. `cli-tools config` prints the merged values and where each one came from.\n\n`--retries` and `--registry` move over as they are; `--dry-run` stays a flag only." },
      ] },
    ],
  },
  hermes: {
    metadata: { model: "hermes-4-405b", reasoning_effort: "medium" },
    turns: [
      { role: "user" as const, ts: t(14), parts: [{ kind: "text" as const, text: "Draft the changelog for 2.0 from the merged pull requests." }] },
      { role: "assistant" as const, ts: t(14, 3), end_ts: t(15, 20), parts: [
        tool("terminal", "gh pr list --state merged --base main", { command: "gh pr list --state merged --base main" }, "#48  feat: retry flaky uploads\n#51  feat: read cli-tools.toml\n#53  fix: exit 2 on a bad flag"),
        { kind: "text" as const, text: "## 2.0\n\n### Added\n- `--retries` retries a failed upload, never a rejected one (#48).\n- Flags can live in `cli-tools.toml` (#51).\n\n### Fixed\n- A bad flag exits with code 2 instead of 1 (#53)." },
      ] },
    ],
  },
  // pi reads its own session file, which is an entry tree rather than a log: a `/tree` move
  // shows only the branch in play, and a `/compact` leaves a summary where it folded the rest.
  cli: {
    metadata: { model: "anthropic/claude-opus-5-5", reasoning_effort: "high" },
    turns: [
      { role: "user" as const, ts: t(11), parts: [{ kind: "text" as const, text: "`release publish` dies on a flaky upload. Retry it, but never on a 4xx." }] },
      { role: "assistant" as const, ts: t(11, 4), end_ts: t(13, 12), parts: [
        { kind: "thinking" as const, text: "A 4xx means the request itself is wrong, so retrying only wastes another upload. The retry belongs around the transport error, not around the call." },
        { kind: "text" as const, text: "I'll find where the upload is issued before wrapping anything." },
        tool("bash", "rg -n upload src/publish", { command: "rg -n upload src/publish" }, "src/publish.ts:41:  const res = await upload(archive);"),
        tool("edit", "src/publish.ts", { path: "src/publish.ts" }, "Updated src/publish.ts"),
        tool("bash", "bun test publish", { command: "bun test publish" }, " 11 pass\n 0 fail\nRan 11 tests across 1 file. [286ms]"),
        { kind: "text" as const, text: "`upload` now retries a transport failure three times with backoff, and a 4xx fails on the first answer. Added `--retries`, defaulting to 3." },
      ] },
      { role: "user" as const, ts: t(20), parts: [{ kind: "compact" as const, text: "## Session Goal\n- Add bounded retries to `release publish` without retrying a 4xx\n\n## Files And Changes\n- `src/publish.ts` — `upload(archive, { retries })`, transport errors only\n- `src/publish.test.ts` — 11 tests, one per status family\n\n## User Preferences\n- Never retry a request the server rejected on purpose" }] },
      { role: "user" as const, ts: t(21), parts: [{ kind: "text" as const, text: "Now expose it as `RELEASE_RETRIES`." }] },
      { role: "assistant" as const, ts: t(21, 3), end_ts: t(22, 40), parts: [
        tool("read", "src/config.ts", { path: "src/config.ts" }, "export interface PublishOptions { … }"),
        tool("edit", "src/config.ts", { path: "src/config.ts" }, "Updated src/config.ts"),
        { kind: "text" as const, text: "`RELEASE_RETRIES` sets the default, and `--retries` still wins over it. The README's environment table lists it." },
      ] },
    ],
  },
};

export const PROMPT: InteractivePrompt = {
  id: "demo-approval",
  agent: "codex",
  kind: "approval" as const,
  // the shape Codex's approval has on the wire: the heading is the question too, and the command
  // is the body (server/prompt.ts)
  title: "Allow command?",
  question: "Allow command?",
  body: "git push origin feat/export-guard",
  options: [
    { label: "Yes", description: null },
    { label: "Yes, and don't ask again for git push", description: null },
    { label: "No, and tell Codex what to do differently", description: null },
  ],
  multi_select: false,
  custom_option_index: null,
};
