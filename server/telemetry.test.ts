import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOTICE_VERSION, type TelemetryChange, type TelemetryEvent, type TelemetrySettings } from "../shared/telemetry.ts";
import { DEFAULT_SETTINGS, telemetrySettingsSnapshot, type Settings } from "../src/lib/settings.ts";
import { handleTelemetryRequest, installMethod, Telemetry, telemetryBlocked } from "./telemetry.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(options: { version?: string; env?: Record<string, string>; status?: number; previous?: string | null; stateDir?: string; grace?: number; fetch?: typeof fetch } = {}) {
  const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), "telemetry-"));
  if (!options.stateDir) dirs.push(stateDir);
  const sent: TelemetryEvent[] = [];
  const fake = options.fetch ?? (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as TelemetryEvent);
    return new Response(null, { status: options.status ?? 204 });
  }) as typeof fetch;
  const clock = { now: Date.parse("2026-10-08T12:00:00Z") };
  const telemetry = new Telemetry({
    stateDir, version: options.version ?? "0.4.1", env: options.env ?? {}, fetch: fake,
    platform: "linux", arch: "x64", previousVersion: () => options.previous ?? null,
    now: () => clock.now, noticeGraceMs: options.grace ?? 0,
  });
  return { telemetry, sent, stateDir, clock };
}

function settingsSnapshot(overrides: Partial<Settings> = {}): TelemetrySettings {
  return telemetrySettingsSnapshot({ ...DEFAULT_SETTINGS, ...overrides });
}

describe("telemetry events", () => {
  test("nothing is sent before the current notice was shown", async () => {
    const { telemetry, sent } = setup();
    await telemetry.report();
    expect(sent).toEqual([]);
    expect(telemetry.status()).toMatchObject({ enabled: true, notice_seen: false, blocked_by_env: false });
  });

  test("the notice sends the install once, and a restart on the same version sends nothing", async () => {
    const { telemetry, sent, stateDir } = setup();
    telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION });
    await telemetry.report();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ event: "install", version: "0.4.1", previous_version: null, os: "linux", arch: "x64", install_method: "source", settings: null });
    expect(sent[0]!.install_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(statSync(join(stateDir, "telemetry.json")).mode & 0o777).toBe(0o600);

    const again = setup({ stateDir });
    await again.telemetry.report();
    expect(again.sent).toEqual([]);
    expect(again.telemetry.status().next).toBeNull();
  });

  test("a new version sends one update from the version last reported", async () => {
    const first = setup();
    first.telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION });
    await first.telemetry.report();
    const next = setup({ stateDir: first.stateDir, version: "0.4.2" });
    await next.telemetry.report();
    expect(next.sent).toEqual([expect.objectContaining({ event: "update", version: "0.4.2", previous_version: "0.4.1", install_id: first.sent[0]!.install_id })]);
  });

  test("the first event of an install updated from before telemetry is an update", async () => {
    const { telemetry, sent } = setup({ previous: "0.4.0" });
    telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION });
    await telemetry.report();
    expect(sent).toEqual([expect.objectContaining({ event: "update", previous_version: "0.4.0" })]);
  });

  test("the switch off sends nothing, and on again sends what is owed", async () => {
    const { telemetry, sent } = setup();
    telemetry.change({ enabled: false, notice_seen: true, notice_version: NOTICE_VERSION });
    await telemetry.report();
    expect(sent).toEqual([]);
    telemetry.change({ enabled: true });
    await telemetry.report();
    expect(sent.map((event) => event.event)).toEqual(["install"]);
  });

  test("the environment can forbid sending whatever the switch says", async () => {
    const environments: Record<string, string>[] = [{ HERDR_WEB_TELEMETRY: "0" }, { DO_NOT_TRACK: "1" }, { CI: "true" }, { HERDR_TEST_MODE: "unit" }];
    for (const env of environments) {
      const { telemetry, sent } = setup({ env });
      telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION });
      await telemetry.report();
      expect(sent).toEqual([]);
      expect(telemetry.status().blocked_by_env).toBe(true);
    }
    expect(telemetryBlocked({ DO_NOT_TRACK: "0" })).toBe(false);
  });

  test("an event the receiver refused is sent again later", async () => {
    const failing = setup({ status: 503 });
    failing.telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION });
    await failing.telemetry.report();
    expect(failing.sent).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(failing.stateDir, "telemetry.json"), "utf8")).reported_version).toBeNull();
    const retry = setup({ stateDir: failing.stateDir });
    await retry.telemetry.report();
    expect(retry.sent).toHaveLength(1);
  });

  test("the first event waits after the notice, so Turn off on the notice sends nothing", async () => {
    const off = setup({ grace: 600_000 });
    off.telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION });
    await off.telemetry.report();
    expect(off.sent).toEqual([]);
    off.telemetry.change({ enabled: false });
    off.clock.now += 600_000;
    await off.telemetry.report();
    expect(off.sent).toEqual([]);

    const kept = setup({ grace: 600_000 });
    kept.telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION });
    kept.clock.now += 599_999;
    await kept.telemetry.report();
    expect(kept.sent).toEqual([]);
    kept.clock.now += 1;
    await kept.telemetry.report();
    expect(kept.sent.map((event) => event.event)).toEqual(["install"]);
  });

  test("turning the switch off stops an event already on its way", async () => {
    let signal: AbortSignal | undefined;
    const pending = (async (_url: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal?.reason)));
    }) as typeof fetch;
    const { telemetry, stateDir } = setup({ fetch: pending });
    telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION });
    const sending = telemetry.report();
    expect(signal?.aborted).toBe(false);
    telemetry.change({ enabled: false });
    expect(signal?.aborted).toBe(true);
    await sending;
    expect(JSON.parse(readFileSync(join(stateDir, "telemetry.json"), "utf8"))).toMatchObject({ enabled: false, reported_version: null });
  });

  test("a switch turned off by another server on the same state directory holds", async () => {
    const first = setup();
    first.telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION });
    await first.telemetry.report();
    const plugin = setup({ stateDir: first.stateDir, version: "0.4.2" });
    const source = setup({ stateDir: first.stateDir, version: "0.4.2" });
    plugin.telemetry.change({ enabled: false });
    await source.telemetry.report();
    expect(source.sent).toEqual([]);
    expect(source.telemetry.status().enabled).toBe(false);
    expect(JSON.parse(readFileSync(join(first.stateDir, "telemetry.json"), "utf8")).enabled).toBe(false);
  });

  test("a state directory that cannot be written leaves the app running and sends nothing", async () => {
    const parent = mkdtempSync(join(tmpdir(), "telemetry-"));
    dirs.push(parent);
    writeFileSync(join(parent, "file"), "");
    const { telemetry, sent } = setup({ stateDir: join(parent, "file", "state") });
    await telemetry.report();
    expect(sent).toEqual([]);
    expect(telemetry.status().enabled).toBe(true);
  });

  test("full safe settings persist across restarts and are included in install and update events", async () => {
    const settings = settingsSnapshot({
      theme: "light",
      terminalFontSize: 18,
      terminalFontFamily: "private font name",
      quickReplies: ["private quick reply"],
      usageHidden: ["private-account-key"],
    });
    const { telemetry, sent, stateDir } = setup();
    telemetry.change({ settings });
    await telemetry.report();
    expect(sent).toEqual([]);

    telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION });
    await telemetry.report();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.settings).toEqual(settings);
    expect(sent[0]!.settings).toMatchObject({ theme: "light", terminalFontSize: 18, terminalFontCustom: true, quickRepliesCustom: true, quickReplyCount: 1, usageHiddenCount: 1 });
    expect(JSON.stringify(sent[0]!.settings)).not.toContain("private font name");
    expect(JSON.stringify(sent[0]!.settings)).not.toContain("private quick reply");
    expect(JSON.stringify(sent[0]!.settings)).not.toContain("private-account-key");
    expect(JSON.parse(readFileSync(join(stateDir, "telemetry.json"), "utf8")).settings).toEqual(settings);

    const restarted = setup({ stateDir });
    expect(restarted.telemetry.status().next).toBeNull();
    await restarted.telemetry.report();
    expect(restarted.sent).toEqual([]);

    const latestSettings = settingsSnapshot({ theme: "system", terminalFontSize: 16 });
    const latestBrowser = setup({ stateDir });
    latestBrowser.telemetry.change({ settings: latestSettings });
    await latestBrowser.telemetry.report();
    expect(latestBrowser.sent).toEqual([]);

    const updated = setup({ stateDir, version: "0.4.2" });
    await updated.telemetry.report();
    expect(updated.sent).toEqual([expect.objectContaining({ event: "update", previous_version: "0.4.1", settings: latestSettings })]);
  });

  test("invalid settings cannot be persisted or sent, and changing settings after a counted version adds no event", async () => {
    const { telemetry, sent, stateDir } = setup();
    const safe = settingsSnapshot();
    const submitted = { ...safe };
    telemetry.change({ settings: submitted });
    submitted.theme = "light";
    const preview = telemetry.status().next?.settings;
    expect(preview).toEqual(safe);
    if (!preview) throw new Error("telemetry preview omitted the settings snapshot");
    preview.theme = "system";
    expect(telemetry.status().next?.settings).toEqual(safe);
    const before = JSON.parse(readFileSync(join(stateDir, "telemetry.json"), "utf8"));

    const invalid = { ...safe, theme: "user supplied text", unknown: true } as unknown as TelemetrySettings;
    expect(() => telemetry.change({ settings: invalid })).toThrow();
    expect(JSON.parse(readFileSync(join(stateDir, "telemetry.json"), "utf8"))).toEqual(before);
    expect(telemetry.status().next?.settings).toEqual(safe);
    expect(sent).toEqual([]);

    telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION });
    await telemetry.report();
    expect(sent).toHaveLength(1);
    telemetry.change({ settings: settingsSnapshot({ theme: "light" }) });
    await telemetry.report();
    expect(sent).toHaveLength(1);
    expect(telemetry.status().next).toBeNull();
    expect(JSON.parse(readFileSync(join(stateDir, "telemetry.json"), "utf8")).settings).toEqual(settingsSnapshot({ theme: "light" }));
  });

  test("notice upgrades preserve the install ID and disabled state, and invalid or legacy settings become null", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
    dirs.push(stateDir);
    const settings = settingsSnapshot();
    writeFileSync(join(stateDir, "telemetry.json"), JSON.stringify({
      install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84",
      enabled: false,
      notice_seen_at: "2026-10-01T00:00:00.000Z",
      notice_version: NOTICE_VERSION - 1,
      reported_version: "0.4.0",
      settings: { ...settings, theme: "invalid" },
      changed_settings: ["theme"],
    }));
    const { telemetry, sent } = setup({ stateDir });
    expect(telemetry.status()).toMatchObject({ enabled: false, notice_seen: false, next: { event: "update", previous_version: "0.4.0", install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", settings: null } });
    telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION });
    await telemetry.report();
    expect(sent).toEqual([]);
    expect(telemetry.status().enabled).toBe(false);
    telemetry.change({ enabled: true });
    await telemetry.report();
    expect(sent).toEqual([expect.objectContaining({ event: "update", install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", settings: null })]);
    const saved = JSON.parse(readFileSync(join(stateDir, "telemetry.json"), "utf8"));
    expect(saved.settings).toBeNull();
    expect(saved.changed_settings).toBeUndefined();
  });

  test("the install method follows how the app was started", () => {
    expect(installMethod({ HERDR_PLUGIN_ROOT: "/x", HERDR_WEB_MANAGED: "1" })).toBe("plugin");
    expect(installMethod({ HERDR_WEB_MANAGED: "1" })).toBe("managed");
    expect(installMethod({})).toBe("source");
  });
});

describe("/api/telemetry", () => {
  const post = (body: unknown, headers: Record<string, string> = { "x-herdr-update": "1" }) =>
    new Request("http://localhost/api/telemetry", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  test("a server without telemetry answers 404", async () => {
    const response = await handleTelemetryRequest(new Request("http://localhost/api/telemetry"));
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });

  test("GET tells the status and previews only an allowlisted event", async () => {
    const { telemetry } = setup();
    const response = await handleTelemetryRequest(new Request("http://localhost/api/telemetry"), telemetry);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ enabled: true, notice_seen: false, next: { event: "install", version: "0.4.1", settings: null } });
  });

  test("POST validates exact settings and current notice acknowledgements before changing state", async () => {
    const { telemetry, sent, stateDir } = setup();
    const settings = settingsSnapshot({ theme: "light", terminalFontFamily: "private font name", quickReplies: ["private reply"] });
    expect((await handleTelemetryRequest(post({ enabled: false }, {}), telemetry)).status).toBe(403);
    expect((await handleTelemetryRequest(post({ enabled: "no" }), telemetry)).status).toBe(400);
    expect((await handleTelemetryRequest(post({ notice_seen: false, notice_version: NOTICE_VERSION }), telemetry)).status).toBe(400);
    expect((await handleTelemetryRequest(post({ notice_seen: true }), telemetry)).status).toBe(400);
    expect((await handleTelemetryRequest(post({ notice_seen: true, notice_version: NOTICE_VERSION - 1 }), telemetry)).status).toBe(400);
    expect((await handleTelemetryRequest(post({ settings: { ...settings, theme: "private text" } }), telemetry)).status).toBe(400);
    expect((await handleTelemetryRequest(post({ settings: { ...settings, extra: true } }), telemetry)).status).toBe(400);
    expect((await handleTelemetryRequest(post({ settings, old_alias: ["theme"] }), telemetry)).status).toBe(400);
    expect(telemetry.status()).toMatchObject({ notice_seen: false, next: { settings: null } });
    expect(JSON.parse(readFileSync(join(stateDir, "telemetry.json"), "utf8")).settings).toBeNull();
    expect(sent).toEqual([]);

    const response = await handleTelemetryRequest(post({ enabled: false, notice_seen: true, notice_version: NOTICE_VERSION, settings }), telemetry);
    expect(await response.json()).toMatchObject({ enabled: false, notice_seen: true, next: { settings } });
    expect(JSON.stringify(telemetry.status())).not.toContain("private font name");
    expect(JSON.stringify(telemetry.status())).not.toContain("private reply");
    expect(JSON.parse(readFileSync(join(stateDir, "telemetry.json"), "utf8")).settings).toEqual(settings);
    await telemetry.report();
    expect(sent).toEqual([]);

    const enabled = await handleTelemetryRequest(post({ enabled: true }), telemetry);
    expect(await enabled.json()).toMatchObject({ enabled: true, next: { settings } });
    await telemetry.report();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.settings).toEqual(settings);
  });

  test("change() requires the exact current notice version before acknowledging", () => {
    const { telemetry } = setup();
    expect(() => telemetry.change({ notice_seen: true } as TelemetryChange)).toThrow();
    expect(() => telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION - 1 })).toThrow();
    expect(telemetry.status().notice_seen).toBe(false);
    expect(telemetry.change({ enabled: false, notice_seen: true, notice_version: NOTICE_VERSION }).notice_seen).toBe(true);
  });
});
