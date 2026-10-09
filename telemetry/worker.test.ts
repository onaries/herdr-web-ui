import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handle, readEvent, requestCountry, type Env } from "./worker.ts";

const event = {
  event: "update", install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", version: "0.4.2", previous_version: "0.4.1",
  os: "linux", arch: "x64", install_method: "plugin",
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
  test("stores the event's fields, the day and the country, never the address", async () => {
    const { env, rows } = fakeDb();
    const response = await handle(from(post(JSON.stringify(event)), { country: "KR", city: "Seoul", postalCode: "04524", latitude: "37.5" }), env, now);
    expect(response.status).toBe(204);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.query).toContain("INSERT OR IGNORE");
    expect(rows[0]!.values).toEqual(["2026-10-08", "update", event.install_id, "0.4.2", "0.4.1", "linux", "x64", "plugin", "KR"]);
    expect(JSON.stringify(rows)).not.toContain("203.0.113.9");
    expect(JSON.stringify(rows)).not.toMatch(/Seoul|04524|37\.5/);
  });

  test("an event with no country, or one that is not two characters, is stored without it", async () => {
    const { env, rows } = fakeDb();
    expect((await handle(post(JSON.stringify(event)), env, now)).status).toBe(204);
    expect(rows[0]!.values[8]).toBeNull();
    // XX is Cloudflare's "unknown" and T1 its Tor marker: neither is a country, and T1 would say more than one
    for (const cf of [undefined, {}, { country: "Korea" }, { country: "kr" }, { country: 82 }, { country: "XX" }, { country: "T1" }]) expect(requestCountry(from(post("{}"), cf))).toBeNull();
    for (const country of ["US", "KR"]) expect(requestCountry(from(post("{}"), { country }))).toBe(country);
  });

  describe("against the real table", () => {
    const schema = readFileSync(join(import.meta.dir, "schema.sql"), "utf8");
    const readme = readFileSync(join(import.meta.dir, "README.md"), "utf8");
    const sqlite = (db: Database): Env => ({ DB: { prepare: (query) => ({ bind: (...values) => ({ run: async () => db.prepare(query).run(...(values as (string | null)[])) }) }) } });
    const send = (env: Env, body: object, country?: string) => handle(from(post(JSON.stringify(body)), country ? { country } : undefined), env, now);

    test("the INSERT fits a new table, and one that got its column from the README's ALTER", async () => {
      const fresh = new Database(":memory:");
      fresh.exec(schema);
      const migrated = new Database(":memory:");
      migrated.exec(schema.replace("  country TEXT,\n", ""));
      // a table from before the country was kept refuses the event: the ALTER goes first
      await expect(send(sqlite(migrated), event, "KR")).rejects.toThrow(/country/);
      migrated.exec(/"(ALTER TABLE events ADD COLUMN[^"]+)"/.exec(readme)![1]!);
      for (const db of [fresh, migrated]) {
        expect((await send(sqlite(db), event, "KR")).status).toBe(204);
        expect(db.query("SELECT country, version FROM events").all()).toEqual([{ country: "KR", version: "0.4.2" }]);
      }
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
    expect((await handle(post(JSON.stringify({ ...event, pad: "x".repeat(4096) })), env, now)).status).toBe(413);
    expect((await handle(new Request("https://receiver.test/v1/events"), env, now)).status).toBe(405);
    expect((await handle(new Request("https://receiver.test/"), env, now)).status).toBe(404);
    expect(rows).toEqual([]);
  });

  test("refuses an oversized body before it ends", async () => {
    const { env, rows } = fakeDb();
    // 4 KB arrive and the stream never closes: the answer must not wait for the rest
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(4096).fill(0x20)); } });
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
