import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TelemetrySettings } from "../shared/telemetry.ts";
import { handle, readEvent, requestCountry, type Env } from "./worker.ts";

const event = {
  event: "update", install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", version: "0.4.2", previous_version: "0.4.1",
  os: "linux", arch: "x64", install_method: "plugin",
};
const settings: TelemetrySettings = {
  terminalInputMode: "auto",
  theme: "dark",
  density: "comfortable",
  sidebarRows: "two",
  agentOrder: "activity",
  agentCards: true,
  agentPins: false,
  quietOpenedDone: true,
  agentMarks: "mono",
  palette: "catppuccin",
  paletteLight: "amber",
  paletteDark: "catppuccin",
  terminalFontSize: 22,
  terminalWheelSpeed: 10,
  paneClipboard: false,
  releasePaneAway: true,
  chatFontSize: 24,
  uiFontSize: null,
  chatWidth: "narrow",
  enterSends: true,
  autoSendQueued: false,
  showThinking: true,
  keepScreenOn: false,
  language: "ko",
  alertsOn: true,
  alertInput: false,
  alertDone: "always",
  alertInApp: true,
  alertSound: false,
  showQuickReplies: true,
  showUsage: true,
  usageCount: "left",
  usageGlance: "session",
  defaultView: "terminal",
  voiceInput: "auto",
  voiceLanguage: "zh-TW",
  voicePolishChat: true,
  voicePolishTerminal: false,
  wrapCode: true,
  markdownWidth: "full",
  diffStyle: "split",
  terminalFontCustom: true,
  chatFontCustom: false,
  shortcutsCustom: true,
  keyBarCustom: false,
  quickRepliesCustom: true,
  quickReplyCount: 12,
  usageHiddenCount: 64,
  usageOrderCustom: true,
};
const now = new Date("2026-10-08T13:45:00Z");

function fakeDb() {
  const rows: { query: string; values: unknown[] }[] = [];
  const env: Env = { DB: { prepare: (query) => ({ bind: (...values) => ({ run: async () => { rows.push({ query, values }); return {}; } }) }) } };
  return { env, rows };
}

const post = (body: string, type = "application/json") =>
  new Request("https://receiver.test/v1/events", { method: "POST", headers: { "content-type": type, "cf-connecting-ip": "203.0.113.9" }, body });
/** Cloudflare hangs what it knows about a request on `cf`; Bun's Request has none */
const from = (request: Request, cf: unknown) => Object.assign(request, { cf });

describe("telemetry receiver", () => {
  test("refuses a field no sender has ever had, and still takes an older sender's changed_settings", async () => {
    const { env, rows } = fakeDb();
    const refused = await handle(from(post(JSON.stringify({ ...event, settings, email: "person@example.com" })), { country: "KR" }), env, now);
    expect(refused.status).toBe(400);
    expect(rows).toHaveLength(0);
    const { settings: _current, ...legacy } = { ...event, settings } as Record<string, unknown>;
    const accepted = await handle(from(post(JSON.stringify({ ...legacy, changed_settings: ["theme", "palette"] })), { country: "KR" }), env, now);
    expect(accepted.status).toBe(204);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.values.at(-1)).toBeNull();
    expect(JSON.stringify(rows)).not.toContain("changed_settings");
  });

  test("stores a normalized complete settings snapshot, the event fields and the country, never the address", async () => {
    const { env, rows } = fakeDb();
    const unordered = Object.fromEntries(Object.entries(settings).reverse());
    const body = { ...event, settings: unordered };
    expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBeLessThan(8192);
    const response = await handle(from(post(JSON.stringify(body)), { country: "KR", city: "Seoul", postalCode: "04524", latitude: "37.5" }), env, now);
    expect(response.status).toBe(204);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.query).toContain("INSERT OR IGNORE");
    expect(rows[0]!.values).toEqual(["2026-10-08", "update", event.install_id, "0.4.2", "0.4.1", "linux", "x64", "plugin", "KR", JSON.stringify(settings)]);
    expect(JSON.stringify(rows)).not.toContain("203.0.113.9");
    expect(JSON.stringify(rows)).not.toMatch(/Seoul|04524|37\.5/);
    expect(readEvent({ ...event, settings: unordered }, now)?.settings).toEqual(settings);
  });

  test("missing and null snapshots stay null; country is stored only when it is a country", async () => {
    const { env, rows } = fakeDb();
    expect((await handle(post(JSON.stringify(event)), env, now)).status).toBe(204);
    expect(rows[0]!.values[8]).toBeNull();
    expect(rows[0]!.values[9]).toBeNull();
    expect((await handle(post(JSON.stringify({ ...event, settings: null })), env, now)).status).toBe(204);
    expect(rows[1]!.values[9]).toBeNull();
    // XX is Cloudflare's "unknown" and T1 its Tor marker: neither is a country, and T1 would say more than one
    for (const cf of [undefined, {}, { country: "Korea" }, { country: "kr" }, { country: 82 }, { country: "XX" }, { country: "T1" }]) expect(requestCountry(from(post("{}"), cf))).toBeNull();
    for (const country of ["US", "KR"]) expect(requestCountry(from(post("{}"), { country }))).toBe(country);
  });

  test("refuses malformed values and unexpected or sensitive snapshot keys without persisting them", async () => {
    const { env, rows } = fakeDb();
    const invalidSettings = [
      { ...settings, theme: "user-selected theme" },
      { ...settings, terminalWheelSpeed: 11 },
      { ...settings, chatFontSize: "16px" },
      { ...settings, account: { accountId: "acct-private-42", email: "person@example.com" } },
      { ...settings, fontFamily: { value: "D2Coding" } },
      Object.fromEntries(Object.entries(settings).filter(([key]) => key !== "agentCards")),
    ];
    for (const bad of invalidSettings) {
      expect(readEvent({ ...event, settings: bad }, now)).toBeNull();
      expect((await handle(post(JSON.stringify({ ...event, settings: bad })), env, now)).status).toBe(400);
    }
    expect(rows).toEqual([]);
  });

  describe("against the real table", () => {
    const schema = readFileSync(join(import.meta.dir, "schema.sql"), "utf8");
    const readme = readFileSync(join(import.meta.dir, "README.md"), "utf8");
    const sqlite = (db: Database): Env => ({ DB: { prepare: (query) => ({ bind: (...values) => ({ run: async () => db.prepare(query).run(...(values as (string | null)[])) }) }) } });
    const send = (env: Env, body: object, country?: string) => handle(from(post(JSON.stringify(body)), country ? { country } : undefined), env, now);

    test("the INSERT fits a new table and an upgraded table while retaining historical rows", async () => {
      const fresh = new Database(":memory:");
      fresh.exec(schema);
      const migrated = new Database(":memory:");
      const legacySchema = schema
        .replace("  country TEXT,\n", "")
        .replace("  settings TEXT CHECK (settings IS NULL OR json_valid(settings)),\n", "  changed_settings TEXT,\n");
      migrated.exec(legacySchema);
      migrated.exec("INSERT INTO events (day, event, install_id, version, previous_version, os, arch, install_method, changed_settings) VALUES ('2026-10-07', 'install', '11111111-2222-4333-8444-555555555555', '0.4.0', NULL, 'linux', 'x64', 'plugin', 'theme')");
      const columns = migrated.query("PRAGMA table_info(events)").all().map((row) => (row as { name: string }).name);
      expect(columns).toContain("changed_settings");
      expect(columns).not.toContain("settings");
      // An existing D1 cannot take the new INSERT until its columns are added.
      await expect(send(sqlite(migrated), event, "KR")).rejects.toThrow(/country|settings/);
      const alters = [...readme.matchAll(/"(ALTER TABLE events ADD COLUMN (?:country|settings) TEXT)"/g)].map((match) => match[1]!);
      expect(alters).toEqual(["ALTER TABLE events ADD COLUMN country TEXT", "ALTER TABLE events ADD COLUMN settings TEXT"]);
      for (const alter of alters) migrated.exec(alter);
      expect(migrated.query("SELECT settings, country, changed_settings FROM events").all()).toEqual([{ settings: null, country: null, changed_settings: "theme" }]);
      for (const db of [fresh, migrated]) {
        expect((await send(sqlite(db), { ...event, settings }, "KR")).status).toBe(204);
        // A replay with different values and country is ignored for the same install/event/version.
        expect((await send(sqlite(db), { ...event, settings: { ...settings, theme: "light" } }, "US")).status).toBe(204);
        expect(db.query("SELECT country, version, settings FROM events WHERE version = '0.4.2'").all()).toEqual([
          { country: "KR", version: "0.4.2", settings: JSON.stringify(settings) },
        ]);
      }
      expect(fresh.query("PRAGMA table_info(events)").all().map((row) => (row as { name: string }).name)).not.toContain("changed_settings");
    });

    test("the README's country query counts an install once, under the last country it was seen in", async () => {
      const db = new Database(":memory:");
      db.exec(schema);
      const env = sqlite(db);
      const other = "7c1d2a90-4b3e-4f5a-8c6d-9e0f1a2b3c4d";
      // one install heard from before the country was kept, then in two countries; another never named one
      db.exec(`INSERT INTO events (day, event, install_id, version, previous_version, os, arch, install_method) VALUES ('2026-10-08', 'install', '${event.install_id}', '0.4.0', NULL, 'linux', 'x64', 'plugin')`);
      await send(env, { ...event, version: "0.4.1", previous_version: "0.4.0" }, "KR");
      await send(env, event, "US");
      // a replay from elsewhere is the same event: it is ignored, and the country stays
      await send(env, event, "JP");
      await send(env, { ...event, install_id: other });
      const query = /-- installs per country[^\n]*\n--[^\n]*\n(SELECT[\s\S]+?;)/.exec(readme)![1]!;
      const counts = db.query(query).all().map((row) => Object.values(row as object));
      expect(counts).toHaveLength(2);
      expect(counts).toContainEqual(["US", 1]);
      expect(counts).toContainEqual([null, 1]);
    });

    test("the README's json_each distribution uses each install's last non-null snapshot", async () => {
      const db = new Database(":memory:");
      db.exec(schema);
      const env = sqlite(db);
      const ids = ["11111111-2222-4333-8444-555555555555", "22222222-3333-4444-8555-666666666666", "33333333-4444-4555-8666-777777777777"];
      // The last non-null snapshot wins, even if a later event has no snapshot; the third install never reports one.
      await send(env, { ...event, install_id: ids[0], version: "0.4.1", previous_version: "0.4.0", settings: { ...settings, theme: "light", density: "compact", agentCards: true } });
      await send(env, { ...event, install_id: ids[0], version: "0.4.3", previous_version: "0.4.2", settings: null });
      await send(env, { ...event, install_id: ids[1], settings: { ...settings, theme: "dark", density: "comfortable", agentCards: false } });
      await send(env, { ...event, install_id: ids[2] });
      const query = /-- values of every setting[\s\S]*?\n(WITH[\s\S]+?;)/.exec(readme)![1]!;
      const values = db.query(query).all().map((row) => Object.values(row as object));
      expect(values).toContainEqual(["theme", "text", "light", 1]);
      expect(values).toContainEqual(["theme", "text", "dark", 1]);
      expect(values).toContainEqual(["agentCards", "true", 1, 1]);
      expect(values).not.toContainEqual(["theme", "text", "dark", 2]);
      const themeQuery = /-- a focused distribution using json_extract[\s\S]*?\n(WITH[\s\S]+?;)/.exec(readme)![1]!;
      const themes = db.query(themeQuery).all().map((row) => Object.values(row as object));
      expect(themes).toContainEqual(["light", 1]);
      expect(themes).toContainEqual(["dark", 1]);
      expect(themes).toHaveLength(2);
    });
  });

  test("refuses what is not one event", async () => {
    const { env, rows } = fakeDb();
    for (const body of [
      "not json", "[]",
      JSON.stringify({ ...event, event: "heartbeat" }),
      JSON.stringify({ ...event, install_id: "me@example.com" }),
      JSON.stringify({ ...event, version: "latest" }),
      JSON.stringify({ ...event, event: "install" }),
      JSON.stringify({ ...event, os: "Linux 6.8 my-laptop" }),
      JSON.stringify({ ...event, install_method: "docker" }),
    ]) expect((await handle(post(body), env, now)).status).toBe(400);
    expect((await handle(post(JSON.stringify(event), "text/plain"), env, now)).status).toBe(415);
    expect((await handle(post(JSON.stringify({ ...event, pad: "x".repeat(9000) })), env, now)).status).toBe(413);
    expect((await handle(new Request("https://receiver.test/v1/events"), env, now)).status).toBe(405);
    expect((await handle(new Request("https://receiver.test/"), env, now)).status).toBe(404);
    expect(rows).toEqual([]);
  });

  test("refuses an oversized body before it ends", async () => {
    const { env, rows } = fakeDb();
    // More than the 8 KB cap arrive and the stream never closes: do not wait for the rest.
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(8193).fill(0x20)); } });
    const request = new Request("https://receiver.test/v1/events", { method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half" } as RequestInit);
    expect((await handle(request, env, now)).status).toBe(413);
    expect(rows).toEqual([]);
  });

  test("a prerelease version is one event too, so its sender is not refused at every start", async () => {
    const { env, rows } = fakeDb();
    expect((await handle(post(JSON.stringify({ ...event, version: "0.5.0-rc.1" })), env, now)).status).toBe(204);
    expect(rows[0]!.values[3]).toBe("0.5.0-rc.1");
    expect(readEvent({ ...event, version: "0.5.0-rc.1; DROP" }, now)).toBeNull();
  });

  test("an install has no previous version", () => {
    expect(readEvent({ ...event, event: "install", previous_version: null }, now)).toMatchObject({ event: "install", previous_version: null });
  });
});
