-- One row per endpoint the app registered: the device token (it never leaves the relay), its
-- service (APNs, or FCM for Android), the APNs environment of an APNs token (NULL for FCM), the VAPID public key of the PC it was registered for
-- (pinned from the start: a push signed by any other key is refused), when it was registered and
-- last used (Unix seconds: the oldest of a token's endpoints is dropped past ENDPOINTS_PER_TOKEN,
-- and one unused for ENDPOINT_TTL_SECONDS is deleted, worker.ts), and the current rate window (its
-- start and the pushes in it). No address, nothing of what a push said.
CREATE TABLE IF NOT EXISTS endpoints (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  service TEXT NOT NULL DEFAULT 'apns' CHECK (service IN ('apns', 'fcm')),
  environment TEXT CHECK (environment IN ('production', 'sandbox')),
  vapid_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER NOT NULL,
  window_start INTEGER NOT NULL DEFAULT 0,
  window_count INTEGER NOT NULL DEFAULT 0,
  CHECK ((service = 'apns') = (environment IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS endpoints_token ON endpoints (token);
CREATE INDEX IF NOT EXISTS endpoints_used_at ON endpoints (used_at);
