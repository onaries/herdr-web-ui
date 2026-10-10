import { describe, expect, it } from "bun:test";
import { WatchStreamParser } from "./watch.ts";

function frame(bytes: string | Uint8Array): string {
  // as herdr 0.9.3 writes it: `encoding` names what the bytes are, and `bytes` is base64 of them
  return JSON.stringify({ type: "terminal.frame", seq: 1, width: 80, height: 24, full: true, encoding: "ansi", bytes: Buffer.from(bytes).toString("base64") });
}

function consumer() {
  const frames: string[] = [];
  let ends = 0;
  const parser = new WatchStreamParser({ onFrame: (data) => frames.push(data), onEnd: () => { ends += 1; } });
  return { parser, frames, ends: () => ends };
}

describe("read-only watch stream", () => {
  it("keeps a split NDJSON record until the next chunk", () => {
    const view = consumer();
    const line = frame("\u001b[Hscreen");
    view.parser.push(line.slice(0, 21));
    expect(view.frames).toEqual([]);
    view.parser.push(`${line.slice(21)}\n`);
    expect(view.frames).toEqual(["\u001b[Hscreen"]);
  });

  it("delivers several records in one chunk in order", () => {
    const view = consumer();
    view.parser.push(`${frame("first")}\n${frame("second")}\n${frame("third")}\n`);
    expect(view.frames).toEqual(["first", "second", "third"]);
  });

  it("delivers a trailing record without a newline at EOF", () => {
    const view = consumer();
    view.parser.push(`${frame("first")}\n${frame("last")}`);
    expect(view.frames).toEqual(["first"]);
    view.parser.finish();
    expect(view.frames).toEqual(["first", "last"]);
  });

  it("preserves a multibyte UTF-8 character split across frame bytes", () => {
    const view = consumer();
    const bytes = new TextEncoder().encode("A한B");
    view.parser.push(`${frame(bytes.slice(0, 2))}\n`);
    expect(view.frames.join("")).toBe("A");
    view.parser.push(`${frame(bytes.slice(2))}\n`);
    view.parser.finish();
    expect(view.frames.join("")).toBe("A한B");
  });

  it("ends exactly once on a closed record and ignores later frames", () => {
    const view = consumer();
    view.parser.push(`${frame("before")}\n{"type":"terminal.closed"}\n${frame("after")}\n`);
    view.parser.push('{"type":"terminal.closed"}\n');
    view.parser.finish();
    expect(view.frames).toEqual(["before"]);
    expect(view.ends()).toBe(1);
  });

  it("recognizes a trailing closed record at EOF", () => {
    const view = consumer();
    view.parser.push('{"type":"terminal.closed"}');
    view.parser.finish();
    expect(view.ends()).toBe(1);
  });

  it("ignores unknown records and unsupported frame encodings", () => {
    const view = consumer();
    view.parser.push('{"type":"terminal.ready"}\n{"type":"terminal.frame","encoding":"text","bytes":"ignored"}\n');
    view.parser.push(`${frame("visible")}\n`);
    expect(view.frames).toEqual(["visible"]);
    expect(view.ends()).toBe(0);
  });
});
