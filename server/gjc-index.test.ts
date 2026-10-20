import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "bun:test";
import { captureGjcIndex, gjcIndexUnchanged } from "./gjc-index.ts";

interface Fixture {
  root: string;
  agentDir: string;
  indexPath: string;
  snapshotPath: string;
}

function record(
  fixture: Fixture,
  type: string,
  indexSeq: number,
  overrides: Record<string, unknown> = {},
): string {
  const unsigned = {
    version: 4,
    indexSeq,
    type,
    sessionId: `session-${indexSeq}`,
    locator: {
      cwd: fixture.root,
      worktreeRoot: null,
      stateRoot: join(fixture.agentDir, "sdk", "state"),
    },
    endpointGeneration: 1,
    pid: 1000 + indexSeq,
    processIncarnation: "process-incarnation",
    hostIncarnation: "host-incarnation",
    activity: { state: "idle", at: 1000 },
    ts: 1000,
    ...overrides,
  };
  const checksum = createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
  return JSON.stringify({ ...unsigned, checksum });
}

function createFixture(initialLog?: string): Fixture & { dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "gjc-index-test-"));
  const agentDir = join(root, "agent");
  const directory = join(agentDir, "sdk", "sessions");
  const indexPath = join(directory, "index.jsonl");
  const snapshotPath = join(directory, "index.snapshot.json");
  mkdirSync(directory, { recursive: true });
  writeFileSync(indexPath, initialLog ?? `${record({ root, agentDir, indexPath, snapshotPath }, "host_registered", 1)}\n`);
  return {
    root,
    agentDir,
    indexPath,
    snapshotPath,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

function withFixture(run: (fixture: Fixture) => void, initialLog?: string): void {
  const fixture = createFixture(initialLog);
  try {
    run(fixture);
  } finally {
    fixture.dispose();
  }
}

function capture(fixture: Fixture) {
  const stamp = captureGjcIndex(fixture.agentDir);
  if (stamp === null) throw new Error("expected a regular GJC index log");
  return stamp;
}

function append(fixture: Fixture, content: string): void {
  appendFileSync(fixture.indexPath, content);
}

function changed(fixture: Fixture, previous: ReturnType<typeof capture>): boolean {
  const current = capture(fixture);
  return gjcIndexUnchanged(fixture.agentDir, previous, current, [777], ["guarded-session"]);
}

describe("GJC index reuse guard", () => {
  it("accepts one or several valid unrelated heartbeat appends", () => {
    for (const count of [1, 3]) {
      withFixture((fixture) => {
        const previous = capture(fixture);
        const rows = Array.from({ length: count }, (_, offset) =>
          `${record(fixture, "host_heartbeat", offset + 2, { sessionId: `unrelated-${offset + 1}` })}\n`,
        ).join("");
        append(fixture, rows);
        const current = capture(fixture);
        expect(gjcIndexUnchanged(fixture.agentDir, previous, current, [777], ["guarded-session"])).toBe(true);
      });
    }
  });

  it("rejects a heartbeat from a pane-owned pid", () => {
    withFixture((fixture) => {
      const previous = capture(fixture);
      append(fixture, `${record(fixture, "host_heartbeat", 2, { pid: 777 })}\n`);
      expect(changed(fixture, previous)).toBe(false);
    });
  });

  it("rejects a guarded session heartbeat even when its pid differs", () => {
    withFixture((fixture) => {
      const previous = capture(fixture);
      append(fixture, `${record(fixture, "host_heartbeat", 2, { sessionId: "guarded-session", pid: 778 })}\n`);
      expect(changed(fixture, previous)).toBe(false);
    });
  });

  it.each(["host_registered", "host_unregistered"] as const)("rejects a %s append", (type) => {
    withFixture((fixture) => {
      const previous = capture(fixture);
      append(fixture, `${record(fixture, type, 2)}\n`);
      expect(changed(fixture, previous)).toBe(false);
    });
  });

  const malformedDeltas: [string, (fixture: Fixture) => string][] = [
    ["malformed JSON", () => "{not-json}\n"],
    ["malformed row", (fixture) => `${record(fixture, "host_heartbeat", 2, { sessionId: null })}\n`],
    ["wrong version", (fixture) => `${record(fixture, "host_heartbeat", 2, { version: 3 })}\n`],
    ["wrong checksum", (fixture) => {
      const row = JSON.parse(record(fixture, "host_heartbeat", 2)) as Record<string, unknown>;
      row.checksum = "invalid-checksum";
      return `${JSON.stringify(row)}\n`;
    }],
    ["partial final line", (fixture) => record(fixture, "host_heartbeat", 2)],
    ["sequence gap", (fixture) => `${record(fixture, "host_heartbeat", 3)}\n`],
    ["reversed sequence", (fixture) =>
      `${record(fixture, "host_heartbeat", 2)}\n${record(fixture, "host_heartbeat", 1)}\n`],
  ];

  it.each(malformedDeltas)("fails closed for %s in the appended log", (_name, makeDelta) => {
    withFixture((fixture) => {
      const previous = capture(fixture);
      append(fixture, makeDelta(fixture));
      expect(changed(fixture, previous)).toBe(false);
    });
  });

  it("rejects a same-size rewrite even when the file stat changes", () => {
    withFixture((fixture) => {
      const previous = capture(fixture);
      const original = readFileSync(fixture.indexPath, "utf8");
      const rewritten = `${record(fixture, "host_registered", 1, { ts: 1001 })}\n`;
      expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(original));
      writeFileSync(fixture.indexPath, rewritten);
      const changedTime = new Date(Date.now() + 60_000);
      utimesSync(fixture.indexPath, changedTime, changedTime);
      expect(changed(fixture, previous)).toBe(false);
    });
  });

  it("rejects a shrinking log", () => {
    withFixture((fixture) => {
      append(fixture, `${record(fixture, "host_heartbeat", 2)}\n`);
      const previous = capture(fixture);
      writeFileSync(fixture.indexPath, `${record(fixture, "host_registered", 1)}\n`);
      expect(changed(fixture, previous)).toBe(false);
    });
  });

  it("rejects an inode replacement despite a valid appended heartbeat", () => {
    withFixture((fixture) => {
      const previous = capture(fixture);
      const replacementPath = join(dirname(fixture.indexPath), "replacement.jsonl");
      const replacement = `${record(fixture, "host_registered", 1)}\n${record(fixture, "host_heartbeat", 2)}\n`;
      writeFileSync(replacementPath, replacement);
      renameSync(replacementPath, fixture.indexPath);
      expect(changed(fixture, previous)).toBe(false);
    });
  });

  it.each(["creation", "change", "removal"] as const)("rejects a snapshot %s", (operation) => {
    withFixture((fixture) => {
      if (operation !== "creation") writeFileSync(fixture.snapshotPath, "{}");
      const previous = capture(fixture);
      append(fixture, `${record(fixture, "host_heartbeat", 2)}\n`);

      if (operation === "creation") {
        writeFileSync(fixture.snapshotPath, "{}");
      } else if (operation === "change") {
        writeFileSync(fixture.snapshotPath, "[]");
        const changedTime = new Date(Date.now() + 60_000);
        utimesSync(fixture.snapshotPath, changedTime, changedTime);
      } else {
        rmSync(fixture.snapshotPath);
      }
      expect(changed(fixture, previous)).toBe(false);
    });
  });

  it("rejects an otherwise valid delta larger than 256 KiB", () => {
    withFixture((fixture) => {
      const previous = capture(fixture);
      const sessionId = `unrelated-${"x".repeat(256 * 1024)}`;
      append(fixture, `${record(fixture, "host_heartbeat", 2, { sessionId })}\n`);
      expect(changed(fixture, previous)).toBe(false);
    });
  });

  it.each([
    ["empty", ""],
    ["incomplete", record({ root: "/tmp", agentDir: "/tmp/agent", indexPath: "", snapshotPath: "" }, "host_registered", 1)],
  ] as const)("rejects a prior %s anchor", (_kind, initialLog) => {
    withFixture((fixture) => {
      const previous = capture(fixture);
      append(fixture, `${record(fixture, "host_heartbeat", 2)}\n`);
      expect(changed(fixture, previous)).toBe(false);
    }, initialLog);
  });

  it("returns null when the index disappears or is replaced by a non-regular file", () => {
    withFixture((fixture) => {
      rmSync(fixture.indexPath);
      expect(captureGjcIndex(fixture.agentDir)).toBeNull();
      mkdirSync(fixture.indexPath);
      expect(captureGjcIndex(fixture.agentDir)).toBeNull();
    });
  });

  it("accepts unchanged index stamps", () => {
    withFixture((fixture) => {
      const previous = capture(fixture);
      const current = capture(fixture);
      expect(gjcIndexUnchanged(fixture.agentDir, previous, current, [777], ["guarded-session"])).toBe(true);
    });
  });

  it("rejects when the captured current stamp no longer matches the on-disk log", () => {
    withFixture((fixture) => {
      const previous = capture(fixture);
      append(fixture, `${record(fixture, "host_heartbeat", 2)}\n`);
      const current = capture(fixture);
      append(fixture, `${record(fixture, "host_heartbeat", 3)}\n`);
      expect(gjcIndexUnchanged(fixture.agentDir, previous, current, [777], ["guarded-session"])).toBe(false);
    });
  });
});
