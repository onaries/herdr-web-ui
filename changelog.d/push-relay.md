### Maintenance
- The phone app's push relay, a Cloudflare Worker for `push.ovis.sh`, is in `push-relay/` with its
  tests: it forwards the PC's end-to-end encrypted alerts to Apple's push service (iOS) or
  Firebase Cloud Messaging (Android) without being able to read them, pins each endpoint to the
  key of the PC it was registered for, rate-limits every endpoint, every phone and every
  registering address, and deletes endpoints unused for 60 days. It is not deployed yet.
