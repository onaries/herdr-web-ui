import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentGet, herdrRpc, paneProcessInfo } from "./client.ts";

// The typed herdr seam (server/herdr/methods.ts). `bun run typecheck` checks the lines marked
// with ts-expect-error below: each must stay a compile error. They hold for a call without an explicit
// result type; `herdrRpc<Inline>(…)` still reaches the untyped fallback, which the files in
// HERDR_RPC_ALLOWED (server/conventions.test.ts) use until a follow-up PR moves them to the
// wrappers once their open PRs land, so outside server/herdr/ that guard, not the compiler,
// keeps server code off herdrRpc.
declare const either: boolean;
async function typeOnly(): Promise<void> {
  // @ts-expect-error pane.process_info takes pane_id: given target, herdr answers for the focused pane
  await herdrRpc("pane.process_info", { target: "pane-1" });
  // @ts-expect-error agent.get takes target
  await herdrRpc("agent.get", { pane_id: "pane-1" });
  // @ts-expect-error pane.send_text needs its text
  await herdrRpc("pane.send_text", { pane_id: "pane-1" });
  // @ts-expect-error a union of typed methods would take either method's params
  await herdrRpc(either ? ("pane.process_info" as const) : ("agent.get" as const), { target: "pane-1" });
  // Known holes: these still compile, because an explicit result type or a plain-string method
  // leaves the fallback's `M` at `string`. Splitting the fallback out under its own name (the
  // follow-up above) turns both into ts-expect-error lines.
  await herdrRpc<unknown>("pane.process_info", { target: "pane-1" });
  const widened: string = "pane.process_info";
  await herdrRpc(widened, { target: "pane-1" });
  const info = await herdrRpc("pane.process_info", { pane_id: "pane-1" });
  const shell: number | null | undefined = info.process_info?.shell_pid;
  const agent = await agentGet("pane-1");
  const kind: string | undefined = agent.agent_session?.kind;
  void shell; void kind;
}
void typeOnly;

// A stand-in herdr on a Unix socket: it records each request and answers with `result`.
let dir = "";
let listener: ReturnType<typeof Bun.listen> | null = null;
afterEach(() => {
  listener?.stop(true);
  listener = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function standIn(result: unknown): { path: string; written: { method: string; params: unknown }[] } {
  dir = mkdtempSync(join(tmpdir(), "herdr-seam-"));
  const path = join(dir, "herdr.sock");
  const written: { method: string; params: unknown }[] = [];
  listener = Bun.listen({
    unix: path,
    socket: {
      data(sock, chunk) {
        const request = JSON.parse(chunk.toString()) as { id: string; method: string; params: unknown };
        written.push({ method: request.method, params: request.params });
        sock.write(`${JSON.stringify({ id: request.id, result })}\n`);
      },
    },
  });
  return { path, written };
}

it("asks pane.process_info by pane_id and answers its process_info", async () => {
  const process_info = { pane_id: "pane-1", shell_pid: 41, foreground_processes: [{ pid: 42, name: "codex", argv: ["codex"] }] };
  const { path, written } = standIn({ type: "pane_process_info", process_info });
  expect(await paneProcessInfo("pane-1", path)).toEqual(process_info);
  expect(written).toEqual([{ method: "pane.process_info", params: { pane_id: "pane-1" } }]);
});

it("asks agent.get by target and answers its agent", async () => {
  const agent = { pane_id: "pane-1", agent_session: { agent: "pi", kind: "path", source: "herdr:pi", value: "/s.jsonl" } };
  const { path, written } = standIn({ type: "agent_info", agent });
  expect(await agentGet("pane-1", path)).toEqual(agent as never);
  expect(written).toEqual([{ method: "agent.get", params: { target: "pane-1" } }]);
});
