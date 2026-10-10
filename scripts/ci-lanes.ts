/**
 * Runs CI commands that do not depend on each other at the same time, one lane each:
 *   bun scripts/ci-lanes.ts "integration=bun run test:integration" "browser=bun scripts/ui-regression.ts"
 * Each line is printed as it arrives under its lane's name, so a hang shows where it is.
 * A failing lane does not stop the others: every lane reports, then the exit code says
 * whether any failed.
 */
export {};

const lanes = process.argv.slice(2).map((argument) => {
  const at = argument.indexOf("=");
  if (at < 1 || at === argument.length - 1) throw new Error(`Usage: bun scripts/ci-lanes.ts name=command ... (got "${argument}")`);
  return { name: argument.slice(0, at), command: argument.slice(at + 1) };
});
if (!lanes.length) throw new Error("Usage: bun scripts/ci-lanes.ts name=command ...");
if (new Set(lanes.map((lane) => lane.name)).size !== lanes.length) throw new Error("Lane names must differ");

async function run(lane: { name: string; command: string }): Promise<{ name: string; code: number; seconds: number }> {
  const startedAt = Date.now();
  const child = Bun.spawn(["bash", "-o", "pipefail", "-ec", `{ ${lane.command}\n} 2>&1`], { stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const decoder = new TextDecoder();
  let rest = "";
  const print = (text: string) => {
    const lines = (rest + text).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) console.log(`[${lane.name}] ${line}`);
  };
  const reader = child.stdout.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      print(decoder.decode(value, { stream: true }));
    }
    print(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  if (rest) console.log(`[${lane.name}] ${rest}`);
  return { name: lane.name, code: await child.exited, seconds: (Date.now() - startedAt) / 1000 };
}

const results = await Promise.all(lanes.map(run));
console.log("");
for (const result of results) console.log(`${result.code === 0 ? "ok    " : "FAILED"} ${result.name} (${result.seconds.toFixed(1)}s, exit ${result.code})`);
process.exit(results.some((result) => result.code !== 0) ? 1 : 0);
