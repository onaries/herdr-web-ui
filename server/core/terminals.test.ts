import { afterEach, expect, it, mock } from "bun:test";
import { ReplayBuffer } from "../output-window.ts";
import { connectionData, type Client } from "./connections.ts";
import type { PaneAttachment } from "./terminal-process.ts";
import type { ServerMessage } from "../../shared/protocol.ts";

let attachment: PaneAttachment;
mock.module("./terminal-process.ts", () => ({
  ATTACH_HELD_MESSAGE: "Held",
  createSpawnAttachment: ({ attachments }: { attachments: Map<string, PaneAttachment> }) => ({
    spawnAttachment: async (pane: string) => { attachments.set(pane, attachment); return attachment; },
  }),
}));
const { createTerminalRegistry } = await import("./terminals.ts");

afterEach(() => mock.restore());

async function join({ readOnly = false, ready, recovering, times = 1 }: { readOnly?: boolean; ready: boolean; recovering?: boolean; times?: number }): Promise<ServerMessage[]> {
  const frames: ServerMessage[] = [];
  const client = {
    data: connectionData({ deviceId: undefined, readOnly }), readyState: WebSocket.OPEN,
    getBufferedAmount: () => 0, send: (text: string) => { frames.push(JSON.parse(text)); return text.length; },
    close() {},
  } as unknown as Client;
  const replay = new ReplayBuffer(1024);
  replay.append("retained screen");
  attachment = {
    kind: "pty", ready, ...(recovering === undefined ? {} : { recovering }), cols: 80, rows: 24, clients: new Set(), grids: new Map(), stalled: new Map(), replay,
    process: { exited: Promise.resolve(), pause() {}, resume() {}, resize() {}, winch() {}, kill() {}, write() {} } as unknown as Extract<PaneAttachment, { kind: "pty" }>["process"],
  };
  const registry = createTerminalRegistry({
    options: {}, clients: new Set([client]), stopped: () => false, terminalAttach: async () => true,
    holdFor: 0, heldRetry: 0, retryFor: 0, relookupFor: 0,
    holdPending() {}, holdPendingPane() {}, end() {},
  });
  for (let attach = 0; attach < times; attach++) await registry.terminalFrames.attach(client, { type: "attach", pane_id: "p", cols: 80, rows: 24, keep_size: true });
  registry.closeAttachment("p");
  registry.conversations.stop();
  return frames;
}

for (const readOnly of [false, true]) for (const ready of [false, true]) {
  it(`preserves input readiness ${ready} after replay for an ${readOnly ? "observer" : "owner"} joining a shared attach`, async () => {
    const frames = await join({ readOnly, ready });
    expect(frames.filter((frame) => frame.type === "pty-data")).toEqual([
      { type: "pty-data", pane_id: "p", data: "retained screen" },
    ]);
    // An input-ready receipt is the existing attach-complete barrier for queued input,
    // not an output-presentation notification. No early negative receipt may satisfy it.
    expect(frames.filter((frame) => frame.type === "input-ready")).toEqual(
      ready ? [{ type: "input-ready", pane_id: "p" }] : [],
    );
    if (ready) expect(frames.findIndex((frame) => frame.type === "input-ready"))
      .toBeGreaterThan(frames.findIndex((frame) => frame.type === "pty-data"));
    expect(frames.some((frame) => frame.type === "output-recovering")).toBe(false);
  });
}

for (const readOnly of [false, true]) {
  it(`tells an ${readOnly ? "observer" : "owner"} joining a recovering attach that its replay is the screen from before, once`, async () => {
    const frames = await join({ readOnly, ready: false, recovering: true, times: 2 });
    expect(frames.filter((frame) => frame.type === "output-recovering")).toEqual([{ type: "output-recovering", pane_id: "p" }]);
    expect(frames.findIndex((frame) => frame.type === "output-recovering"))
      .toBeLessThan(frames.findIndex((frame) => frame.type === "pty-data"));
    // presentation only: the queued-input barrier still waits for the attach to take
    expect(frames.filter((frame) => frame.type === "input-ready")).toEqual([]);
  });
}
