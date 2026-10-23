import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GJC_NATIVE_DIRECTORY, GJC_NATIVE_LEASE_MS, type GjcNativeBinding } from "../shared/gjc-native.ts";
import { GJC_NATIVE_MAX_BYTES, readGjcNativeBinding, validateGjcNativeTranscript } from "./gjc-native.ts";

const tempDir = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

function fixture() {
  const home = tempDir("gjc-native-record-");
  const cwd = join(home, "work");
  const agentDir = join(home, ".gjc", "agent");
  const identityDir = join(agentDir, GJC_NATIVE_DIRECTORY);
  const sessions = join(agentDir, "sessions", "v2-project");
  mkdirSync(cwd);
  mkdirSync(identityDir, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  const sessionFile = (id: string, sessionCwd = cwd, name = `${id}.jsonl`) => {
    const path = join(sessions, name);
    writeFileSync(path, `${JSON.stringify({ type: "session", id, cwd: sessionCwd })}\n{}\n`);
    return path;
  };
  const record = (overrides: Partial<GjcNativeBinding> = {}): GjcNativeBinding => ({
    version: 1,
    pid: 200,
    processStartedAt: 1_000,
    instanceId: "extension-instance-1",
    sequence: 1,
    updatedAt: 10_000,
    session: { id: "session-a", path: sessionFile("session-a"), cwd },
    ...overrides,
  });
  const write = (value: unknown, pid = 200) => {
    const path = join(identityDir, `${pid}.json`);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  return { home, cwd, agentDir, identityDir, sessions, sessionFile, record, write, done: () => rmSync(home, { recursive: true, force: true }) };
}

it("reads only the current process record and observes sequence/session transitions", () => {
  const f = fixture();
  try {
    const first = f.record();
    f.write(first);
    expect(readGjcNativeBinding(f.home, 200, 10_000)).toEqual(first);

    const resumed = f.record({ sequence: 2, session: { id: "session-b", path: f.sessionFile("session-b"), cwd: f.cwd } });
    f.write(resumed);
    expect(readGjcNativeBinding(f.home, 200, 10_000)).toEqual(resumed);
    expect(readGjcNativeBinding(f.home, 201, 10_000)).toBeNull();

    const idle = f.record({ sequence: 3, session: null });
    f.write(idle);
    expect(readGjcNativeBinding(f.home, 200, 10_000)?.session).toBeNull();
  } finally { f.done(); }
});

it("rejects missing, malformed, oversized, expired and future identity records", () => {
  const f = fixture();
  try {
    expect(readGjcNativeBinding(f.home, 200, 10_000)).toBeNull();
    const valid = f.record();
    const path = f.write({ ...valid, version: 2 });
    expect(readGjcNativeBinding(f.home, 200, 10_000)).toBeNull();
    f.write({ ...valid, extra: true });
    expect(readGjcNativeBinding(f.home, 200, 10_000)).toBeNull();

    f.write({ ...valid, updatedAt: 10_000 - GJC_NATIVE_LEASE_MS });
    expect(readGjcNativeBinding(f.home, 200, 10_000)).toBeNull();
    f.write({ ...valid, updatedAt: 10_001 });
    expect(readGjcNativeBinding(f.home, 200, 10_000)).toBeNull();
    f.write({ ...valid, updatedAt: 999 });
    expect(readGjcNativeBinding(f.home, 200, 10_000)).toBeNull();
    f.write({ ...valid, processStartedAt: 10_001 });
    expect(readGjcNativeBinding(f.home, 200, 10_000)).toBeNull();
    f.write({ ...valid, sequence: 0 });
    expect(readGjcNativeBinding(f.home, 200, 10_000)).toBeNull();
    writeFileSync(path, JSON.stringify(valid).padEnd(GJC_NATIVE_MAX_BYTES + 1, " "));
    expect(readGjcNativeBinding(f.home, 200, 10_000)).toBeNull();
  } finally { f.done(); }
});

it("rejects record symlinks that point outside the native identity directory", () => {
  const f = fixture();
  try {
    const outside = join(f.home, "outside.json");
    writeFileSync(outside, JSON.stringify(f.record()));
    symlinkSync(outside, join(f.identityDir, "200.json"));
    expect(readGjcNativeBinding(f.home, 200, 10_000)).toBeNull();
  } finally { f.done(); }
});

it("validates the canonical main transcript's first-line session id and cwd", () => {
  const f = fixture();
  try {
    const good = f.sessionFile("session-a");
    const binding = f.record({ session: { id: "session-a", path: good, cwd: f.cwd } });
    expect(validateGjcNativeTranscript(binding, f.cwd, f.home)).toBe(realpathSync(good));

    const sibling = join(f.home, "sibling");
    mkdirSync(sibling);
    const wrongId = f.sessionFile("wrong-id", f.cwd, "wrong-id.jsonl");
    expect(validateGjcNativeTranscript({ ...binding, session: { id: "session-a", path: wrongId, cwd: f.cwd } }, f.cwd, f.home)).toBeNull();
    const wrongCwd = f.sessionFile("session-a", sibling, "wrong-cwd.jsonl");
    expect(validateGjcNativeTranscript({ ...binding, session: { id: "session-a", path: wrongCwd, cwd: f.cwd } }, f.cwd, f.home)).toBeNull();

    const outside = join(f.home, "outside.jsonl");
    writeFileSync(outside, `${JSON.stringify({ type: "session", id: "session-a", cwd: f.cwd })}\n`);
    expect(validateGjcNativeTranscript({ ...binding, session: { id: "session-a", path: outside, cwd: f.cwd } }, f.cwd, f.home)).toBeNull();
    const outsideLink = join(f.sessions, "outside-link.jsonl");
    symlinkSync(outside, outsideLink);
    expect(validateGjcNativeTranscript({ ...binding, session: { id: "session-a", path: outsideLink, cwd: f.cwd } }, f.cwd, f.home)).toBeNull();

    const subagentDir = join(f.sessions, "session-a");
    mkdirSync(subagentDir);
    const subagent = join(subagentDir, "worker.jsonl");
    writeFileSync(subagent, `${JSON.stringify({ type: "session", id: "session-a", cwd: f.cwd })}\n`);
    expect(validateGjcNativeTranscript({ ...binding, session: { id: "session-a", path: subagent, cwd: f.cwd } }, f.cwd, f.home)).toBeNull();
  } finally { f.done(); }
});

it("rejects malformed or overlong first-line transcript headers", () => {
  const f = fixture();
  try {
    const binding = f.record();
    const malformed = join(f.sessions, "malformed.jsonl");
    writeFileSync(malformed, "{not-json}\n");
    expect(validateGjcNativeTranscript({ ...binding, session: { id: "session-a", path: malformed, cwd: f.cwd } }, f.cwd, f.home)).toBeNull();

    const noNewline = join(f.sessions, "no-newline.jsonl");
    writeFileSync(noNewline, JSON.stringify({ type: "session", id: "session-a", cwd: f.cwd }));
    expect(validateGjcNativeTranscript({ ...binding, session: { id: "session-a", path: noNewline, cwd: f.cwd } }, f.cwd, f.home)).toBeNull();

    const longButValid = join(f.sessions, "long-but-valid.jsonl");
    writeFileSync(longButValid, `${JSON.stringify({ type: "session", id: "session-a", cwd: f.cwd, padding: "x".repeat(GJC_NATIVE_MAX_BYTES + 1024) })}\n`);
    expect(validateGjcNativeTranscript({ ...binding, session: { id: "session-a", path: longButValid, cwd: f.cwd } }, f.cwd, f.home)).toBe(realpathSync(longButValid));

    const tooLong = join(f.sessions, "too-long.jsonl");
    writeFileSync(tooLong, `${JSON.stringify({ type: "session", id: "session-a", cwd: f.cwd, padding: "x".repeat(64 * 1024) })}\n`);
    expect(validateGjcNativeTranscript({ ...binding, session: { id: "session-a", path: tooLong, cwd: f.cwd } }, f.cwd, f.home)).toBeNull();
  } finally { f.done(); }
});
