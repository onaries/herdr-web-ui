import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore, normalizeLabel } from "./devices.ts";
import { isTaggedNode, parseTailscaleOwner } from "./tailscale.ts";

const dir = mkdtempSync(join(tmpdir(), "herdr-devices-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("DeviceStore", () => {
  it("keeps an unreadable or invalid registry gated and intact for recovery", () => {
    for (const contents of ["{broken", "null", "{}", '{"devices":[]}', '{"gate_closed_at":null,"devices":[{}]}']) {
      const root = mkdtempSync(join(dir, "invalid-"));
      const path = join(root, "devices.json");
      writeFileSync(path, contents);
      const store = new DeviceStore(root);
      expect(store.gated).toBe(true);
      expect(store.error).toContain("Restore a valid devices.json");
      expect(() => store.startPairing()).toThrow();
      expect(() => store.revoke("any")).toThrow();
      expect(readFileSync(path, "utf8")).toBe(contents);
    }
    const unreadable = mkdtempSync(join(dir, "unreadable-"));
    mkdirSync(join(unreadable, "devices.json"));
    expect(new DeviceStore(unreadable).gated).toBe(true);
    const fresh = new DeviceStore(mkdtempSync(join(dir, "fresh-")));
    expect(fresh.error).toBeNull();
    expect(fresh.gated).toBe(false);

    const legacy = mkdtempSync(join(dir, "legacy-gate-"));
    writeFileSync(join(legacy, "devices.json"), JSON.stringify({
      gate_closed_at: null,
      devices: [{ id: "0123456789abcdef", label: "Legacy", role: "drive", token_hash: "hash", created_at: new Date().toISOString(), last_seen_at: null }],
    }));
    const legacyStore = new DeviceStore(legacy);
    expect(legacyStore.gated).toBe(true);
    expect(legacyStore.list(null)[0]?.last_seen_at).toBeNull();
    expect(legacyStore.revoke("0123456789abcdef")).toBe(true);
    expect(legacyStore.gated).toBe(true);
    expect(new DeviceStore(legacy).gated).toBe(true);
  });

  it("closes only the revoked device's listeners, including late registrations", () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "listeners-")));
    const a = store.pair(store.startPairing().code, "A", "drive")!;
    expect(store.match(a.token)).not.toBeNull();
    const b = store.pair(store.startPairing().code, "B", "drive")!;
    expect(store.match(b.token)).not.toBeNull();
    const closed: string[] = [];
    store.onRevoke(a.device.id, () => closed.push("a"));
    store.onRevoke(b.device.id, () => closed.push("b"));
    const unsubscribe = store.onRevoke(a.device.id, () => closed.push("finished"));
    unsubscribe();
    store.revoke(a.device.id);
    store.onRevoke(a.device.id, () => closed.push("late upgrade"));
    expect(closed).toEqual(["a", "late upgrade"]);
    expect(store.match(b.token)).not.toBeNull();
  });

  it("pairs with the code once, keeps only a hash, and finds the device by its token", () => {
    const store = new DeviceStore(dir);
    expect(store.gated).toBe(false);
    const { code } = store.startPairing();
    expect(code).toMatch(/^\d{6}$/);
    expect(store.pair("000000".replace(/./g, (c) => c === code[0] ? "1" : c), "x", "drive")).toBeNull(); // a wrong code
    const paired = store.pair(code.slice(0, 3) + " " + code.slice(3), "My phone", "drive");
    expect(paired).not.toBeNull();
    expect(store.pair(code, "again", "drive")).toBeNull(); // spent
    expect(store.gated).toBe(false);
    expect(store.list(null)).toEqual([]);
    expect(() => statSync(join(dir, "devices.json"))).toThrow();
    expect(new DeviceStore(dir).gated).toBe(false); // an unreturned cookie is not durable across restart
    expect(new DeviceStore(dir).match(paired!.token)).toBeNull();
    expect(store.match(paired!.token)).toEqual({ id: paired!.device.id, label: "My phone", role: "drive" });
    expect(store.gated).toBe(true);
    const file = readFileSync(join(dir, "devices.json"), "utf8");
    expect(file).not.toContain(paired!.token);
    expect((statSync(join(dir, "devices.json")).mode & 0o777)).toBe(0o600);
    expect(new DeviceStore(dir).gated).toBe(true);
    expect(store.match("not-a-token")).toBeNull();
    // and a second store reading the same file knows the device
    expect(new DeviceStore(dir).match(paired!.token)?.label).toBe("My phone");
  });

  it("expires a code after ten minutes and after five wrong tries", () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "s-")));
    const started = Date.now();
    const { code } = store.startPairing(started);
    expect(store.pair(code, "late", "drive", started + 10 * 60_000 + 1)).toBeNull();
    const second = store.startPairing().code;
    for (let i = 0; i < 5; i++) expect(store.pair("999999" === second ? "000000" : "999999", "x", "drive")).toBeNull();
    expect(store.pair(second, "x", "drive")).toBeNull();
  });

  it("keeps a first-pair retry open, preserves issued candidates across replaced codes, and bounds them", () => {
    const root = mkdtempSync(join(dir, "retry-"));
    const store = new DeviceStore(root);
    const now = Date.now();
    const replaced = store.startPairing(now).code;
    const firstCode = store.startPairing(now + 1).code;
    expect(store.pair(replaced, "obsolete", "drive", now + 1)).toBeNull();
    const lost = store.pair(firstCode, "Lost cookie", "drive", now + 1)!;
    const retry = store.pair(store.startPairing(now + 2).code, "Retry", "drive", now + 2)!;
    expect(store.gated).toBe(false);
    expect(store.list(null)).toEqual([]);
    expect(store.match(retry.token, now + 3)).toEqual(retry.device);
    expect(store.gated).toBe(true);
    expect(store.match(lost.token, now + 4)).toBeNull();
    expect(store.list(null)).toHaveLength(1);
    expect(store.revoke(retry.device.id)).toBe(true);
    expect(store.gated).toBe(true);
    expect(store.match(lost.token, now + 5)).toBeNull();
    expect(store.list(null)).toEqual([]);
    expect(new DeviceStore(root).gated).toBe(true);

    const bounded = new DeviceStore(mkdtempSync(join(dir, "bounded-")));
    const issued: { token: string; device: { id: string; label: string; role: "drive" | "watch" } }[] = [];
    for (let i = 0; i < 9; i += 1) {
      const at = now + i * 2;
      issued.push(bounded.pair(bounded.startPairing(at).code, `Device ${i}`, "drive", at)!);
    }
    expect(bounded.match(issued[0]!.token, now + 20)).toBeNull();
    expect(bounded.gated).toBe(false);
    expect(bounded.list(null)).toEqual([]);
    expect(bounded.match(issued[8]!.token, now + 20)).not.toBeNull();
    expect(bounded.gated).toBe(true);
  });

  it("expires unconfirmed first-pair cookies and loses them on restart without closing the gate", () => {
    const root = mkdtempSync(join(dir, "candidate-expiry-"));
    const store = new DeviceStore(root);
    const started = Date.now();
    const paired = store.pair(store.startPairing(started).code, "Expired", "drive", started)!;
    expect(store.match(paired.token, started + 10 * 60_000 + 1)).toBeNull();
    expect(store.gated).toBe(false);
    expect(store.list(null)).toEqual([]);
    expect(new DeviceStore(root).gated).toBe(false);
  });

  it("renames, revokes, and marks the caller's device", () => {
    const root = mkdtempSync(join(dir, "r-"));
    const store = new DeviceStore(root);
    const a = store.pair(store.startPairing().code, "A", "drive")!;
    store.match(a.token);
    const b = store.pair(store.startPairing().code, "B", "drive")!;
    const reloaded = new DeviceStore(root);
    expect(reloaded.gated).toBe(true);
    expect(reloaded.list(null).find((device) => device.id === b.device.id)?.last_seen_at).toBeNull();
    store.match(b.token);
    expect(store.list(a.device.id).map((d) => [d.label, d.current])).toEqual([["A", true], ["B", false]]);
    expect(store.update(b.device.id, { label: "Bee" })?.label).toBe("Bee");
    expect(store.revoke(a.device.id)).toBe(true);
    expect(store.revoke(a.device.id)).toBe(false);
    expect(store.match(a.token)).toBeNull();
    expect(store.match(b.token)?.label).toBe("Bee");
    // revoking the last device does not reopen the gate, not even after a restart
    expect(store.revoke(b.device.id)).toBe(true);
    expect(store.gated).toBe(true);
    expect(new DeviceStore(root).gated).toBe(true);
  });
});

describe("labels and owner", () => {
  it("trims labels and falls back", () => {
    expect(normalizeLabel("  my   phone ", "Device")).toBe("my phone");
    expect(normalizeLabel("", "Device")).toBe("Device");
    expect(normalizeLabel(42, "Device")).toBe("Device");
    expect(normalizeLabel("x".repeat(80), "Device")).toHaveLength(48);
  });

  it("reads the PC's login out of tailscale status", () => {
    const status = JSON.stringify({ Self: { UserID: 42 }, User: { "42": { LoginName: "me@example.com" }, "43": { LoginName: "them@example.com" } } });
    expect(parseTailscaleOwner(status)).toBe("me@example.com");
    expect(parseTailscaleOwner(JSON.stringify({ Self: { UserID: 99 }, User: {} }))).toBeNull();
    // a real id is past 2^53: as a double it becomes ...136 and names nobody (#526)
    expect(parseTailscaleOwner('{"Self":{"UserID":15633668397603135},"User":{"15633668397603135":{"LoginName":"me@example.com"}}}')).toBe("me@example.com");
    expect(parseTailscaleOwner(null)).toBeNull();
    expect(parseTailscaleOwner("nope")).toBeNull();
    expect(isTaggedNode(status)).toBeFalse();
    // a tagged node's user entry is the node itself: no person's login
    const tagged = JSON.stringify({ Self: { UserID: 7, Tags: ["tag:server"] }, User: { "7": { LoginName: "pc.tailnet.ts.net" } } });
    expect(parseTailscaleOwner(tagged)).toBeNull();
    expect(isTaggedNode(tagged)).toBeTrue();
    expect(isTaggedNode(null)).toBeFalse();
  });
});

it("reports failed registry writes without committing a pair, rename or revocation in memory", () => {
  const root = mkdtempSync(join(dir, "write-failure-"));
  const store = new DeviceStore(root);
  const first = store.pair(store.startPairing().code, "Original", "drive")!;
  store.match(first.token);
  let closed = false;
  store.onRevoke(first.device.id, () => { closed = true; });
  const blocked = join(root, `devices.json.${process.pid}.tmp`);
  mkdirSync(blocked);
  const code = store.startPairing().code;
  expect(() => store.pair(code, "Failed pair", "drive")).toThrow();
  expect(() => store.update(first.device.id, { label: "Failed rename" })).toThrow();
  expect(() => store.revoke(first.device.id)).toThrow();
  expect(closed).toBe(false);
  expect(store.list(null).map((d) => d.label)).toEqual(["Original"]);
  expect(store.match(first.token)?.label).toBe("Original");
  expect(new DeviceStore(root).match(first.token)?.label).toBe("Original");
  rmSync(blocked, { recursive: true });
  expect(store.pair(code, "Retry", "drive")).not.toBeNull();
  expect(store.revoke(first.device.id)).toBe(true);
  expect(closed).toBe(true);
  expect(new DeviceStore(root).match(first.token)).toBeNull();
});

it("does not authorize a first-pair cookie when promotion cannot be persisted", () => {
  const root = mkdtempSync(join(dir, "promotion-failure-"));
  const store = new DeviceStore(root);
  const candidate = store.pair(store.startPairing().code, "Pending", "drive")!;
  const blocked = join(root, `devices.json.${process.pid}.tmp`);
  mkdirSync(blocked);
  expect(() => store.match(candidate.token)).toThrow();
  expect(store.gated).toBe(false);
  expect(store.list(null)).toEqual([]);
  expect(new DeviceStore(root).gated).toBe(false);
  rmSync(blocked, { recursive: true });
  expect(store.match(candidate.token)).toEqual(candidate.device);
  expect(store.gated).toBe(true);
  expect(new DeviceStore(root).match(candidate.token)).toEqual(candidate.device);
});
