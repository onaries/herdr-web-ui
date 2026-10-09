# Telemetry receiver

The Cloudflare Worker that receives the app's anonymous install and update counts. What the app
sends and when is in [the guide](../docs/guide.md#anonymous-usage-counts); the sender is
`server/telemetry.ts`.

It stores one row per install, event and version in a D1 table (`schema.sql`): the day, the
event, the random install ID, the version and the version it replaced, the OS, the CPU
architecture and how the app was installed. It adds the country the request came from: the two
characters Cloudflare works out from the sender's address (`request.cf.country`, such as `KR`),
and nothing finer (no city, region or network; a request Cloudflare marks as Tor or unknown is
stored with no country). The Worker itself never reads the sender's address
or any header other than the content type, and Workers Logs are off (`wrangler.toml`), so no
request log keeps the address either.

## Deploy

```sh
cd telemetry
bunx wrangler login
bunx wrangler d1 create herdr-web-ui-telemetry   # done once: its database_id is in wrangler.toml; only a new account repeats it
bunx wrangler d1 execute herdr-web-ui-telemetry --remote --file schema.sql
bunx wrangler deploy
```

A database made before the country was kept needs its column once, before the Worker that writes
it is deployed (an INSERT naming a missing column fails, and the event is lost until its sender
starts again):

```sh
bunx wrangler d1 execute herdr-web-ui-telemetry --remote --command "ALTER TABLE events ADD COLUMN country TEXT"
```

The Worker answers at `https://herdr-web-ui-telemetry.<account>.workers.dev/v1/events`, and
`TELEMETRY_URL` in `server/telemetry.ts` must name that address. `HERDR_WEB_TELEMETRY_URL` does not
exist on purpose: an install cannot be pointed elsewhere by its environment.

## Reading the counts

```sh
bunx wrangler d1 execute herdr-web-ui-telemetry --remote --command "<query>"
```

```sql
-- new installs per week
SELECT strftime('%Y-%W', day) AS week, COUNT(*) FROM events WHERE event = 'install' GROUP BY week ORDER BY week;
-- installs that updated in the last 30 days: the closest thing to active installs
SELECT COUNT(DISTINCT install_id) FROM events WHERE event = 'update' AND day >= date('now', '-30 days');
-- installs per version they last reported
SELECT version, COUNT(*) FROM (SELECT install_id, MAX(version) AS version FROM events GROUP BY install_id) GROUP BY version ORDER BY version;
-- OS, architecture and install method
SELECT os, arch, install_method, COUNT(DISTINCT install_id) FROM events GROUP BY os, arch, install_method;
-- installs per country, each counted once under the last country it was seen in; NULL is an
-- install never seen with one (heard from only before the country was kept, or never named one)
SELECT country, COUNT(*) FROM (
  SELECT (SELECT country FROM events WHERE install_id = e.install_id AND country IS NOT NULL ORDER BY rowid DESC LIMIT 1) AS country
  FROM events e GROUP BY install_id
) GROUP BY country ORDER BY 2 DESC;
```

`MAX(version)` compares text, which orders `0.10.0` before `0.9.0`; read the version table with
that in mind once a part reaches two digits.

Anyone can post an event that passes the checks, so the counts are a trend, not an audit.
