/**
 * One real push through a deployed relay, to check the whole path after a deploy: registration,
 * the relay's request to APNs (which takes HTTP/2 only, so only a real APNs shows it works) and the
 * phone. It registers the given device token with a throwaway VAPID key, then sends one push
 * signed and encrypted with web-push as server/push.ts does. The keys are made here, not the
 * app's, so the phone cannot decrypt it and shows the fallback line ("herdr needs you").
 *
 *   bun push-relay/test-push.ts <APNs device token, hex> [production|sandbox] [relay origin]
 *
 * The relay answers 201 once APNs took the push. The endpoint it registered is never pushed to
 * again and expires with the others (ENDPOINT_TTL_SECONDS).
 */

import webpush from "web-push";

const [token, environment = "production", relay = "https://push.ovis.sh"] = process.argv.slice(2);
if (!token || (environment !== "production" && environment !== "sandbox")) {
  console.error("usage: bun push-relay/test-push.ts <APNs device token, hex> [production|sandbox] [relay origin]");
  process.exit(2);
}

const pc = webpush.generateVAPIDKeys();
const registered = await fetch(`${relay}/v1/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token, environment, vapid_key: pc.publicKey }),
});
console.log(`register: ${registered.status}`);
if (registered.status !== 201) process.exit(1);
const { endpoint } = (await registered.json()) as { endpoint: string };

const device = { p256dh: webpush.generateVAPIDKeys().publicKey, auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url") };
const details = webpush.generateRequestDetails({ endpoint, keys: device }, JSON.stringify({ title: "Ovis", body: "relay test" }), {
  vapidDetails: { subject: "https://github.com/devswha/ovis", publicKey: pc.publicKey, privateKey: pc.privateKey },
  TTL: 60, urgency: "high", contentEncoding: "aes128gcm",
});
const headers: Record<string, string> = {};
for (const [name, value] of Object.entries(details.headers)) headers[name] = String(value);
const pushed = await fetch(details.endpoint, { method: "POST", headers, body: new Uint8Array(details.body) });
console.log(`push: ${pushed.status}${pushed.status === 201 ? " (APNs took it: the phone should show \"herdr needs you\")" : ""}`);
process.exit(pushed.status === 201 ? 0 : 1);
