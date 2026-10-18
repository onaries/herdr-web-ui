import { expect, it, spyOn } from "bun:test";
import { createOmpProcessProbe, processStartTicks } from "./omp-process.ts";

it.skipIf(process.platform !== "linux")("reads a live process's arguments and only the environment omp lookups need", async () => {
  const env = { PATH: process.env["PATH"] ?? "", OMP_PROFILE: "personal", TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%3", SECRET_TOKEN: "do-not-pass" };
  const target = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  try {
    const read = createOmpProcessProbe();
    const result = await read(target.pid, true);
    expect(result?.argv.length).toBeGreaterThan(0);
    expect([...result?.environ ?? []].sort()).toEqual(["OMP_PROFILE=personal", "TMUX=/tmp/tmux-1/default,1,0", "TMUX_PANE=%3"]);
    expect((await createOmpProcessProbe()(target.pid, false))?.argv).toEqual([]);
    expect(await read(2147483647, true)).toBeNull();
  } finally { target.kill(); await target.exited; }
});

it.skipIf(process.platform !== "linux")("keeps a successful read per process start, never a failed one", async () => {
  const start = processStartTicks(process.pid)!;
  let starts = 0, fail = true, ticks = start;
  const read = createOmpProcessProbe({
    startTicks: () => ticks,
    command: () => { starts++; return [process.execPath, "-e", fail ? "process.exit(1)" : `console.log(JSON.stringify({start:${JSON.stringify(start)},argv:["omp"],environ:[]}))`]; },
  });
  expect(await read(process.pid, true)).toBeNull();
  fail = false;
  expect((await read(process.pid, true))?.argv).toEqual(["omp"]);
  expect((await read(process.pid, true))?.argv).toEqual(["omp"]);
  expect((await read(process.pid, false))?.argv).toEqual(["omp"]);
  expect(starts).toBe(2);
  // the pid now names a process that started at another time: the helper's answer is not its
  ticks = `${start}1`;
  expect(await read(process.pid, true)).toBeNull();
  expect(starts).toBe(3);
});

it.skipIf(process.platform !== "linux")("a stalled memory read has a deadline and leaves the event loop responsive", async () => {
  const read = createOmpProcessProbe({ timeoutMs: 100, command: () => [process.execPath, "-e", "setInterval(() => {}, 1000)"] });
  const result = read(process.pid, true);
  let settled = false;
  void result.then(() => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  expect(await Promise.race([result, new Promise((resolve) => setTimeout(() => resolve("deadline missed"), 1000))])).toBeNull();
});

it.skipIf(process.platform !== "linux")("deduplicates reads and bounds outstanding helpers when polling repeats", async () => {
  let starts = 0;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const read = createOmpProcessProbe({ timeoutMs: 100, maxProcesses: 1, startTicks: () => "1", command: () => { starts++; return [process.execPath, "-e", "setInterval(() => {}, 1000)"]; } });
    const first = read(1, true);
    expect(read(1, true)).toBe(first);
    expect(await read(2, true)).toBeNull();
    expect(await read(3, true)).toBeNull();
    expect(starts).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await first).toBeNull();
  } finally { warn.mockRestore(); }
});

it.skipIf(process.platform !== "linux")("rejects malformed or excessive helper output and invalid process IDs", async () => {
  for (const script of ["console.log('not JSON')", "console.log(JSON.stringify({argv:[42],environ:[]}))", "console.log(JSON.stringify({start:'0',argv:[],environ:[]}))", "console.log('x'.repeat(1024*1024+1))", "process.exit(1)"]) {
    const read = createOmpProcessProbe({ command: () => [process.execPath, "-e", script] });
    expect(await read(process.pid, true)).toBeNull();
  }
  let starts = 0;
  const read = createOmpProcessProbe({ command: () => { starts++; return []; } });
  for (const pid of [-1, 0, 1.5, Number.NaN]) expect(await read(pid, true)).toBeNull();
  expect(starts).toBe(0);
});
