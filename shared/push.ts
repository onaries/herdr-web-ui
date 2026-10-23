/** GET /api/push: base64url VAPID public key, the `applicationServerKey` a browser subscribes with. */
export interface PushKey {
  readonly public_key: string;
}

/**
 * The JSON inside every web push, decrypted by the device's service worker (public/sw.js)
 * and shown as a notification. `pane_id` is null for the enable-confirmation push; `tag`
 * is shared with the in-tab notification of the same pane, so one replaces the other.
 */
export interface PushPayload {
  /** Absent in legacy payloads means local. */
  machine_id?: string;
  pane_id: string | null;
  /** The workspace the pane was last seen in, so the tap of an ended pane opens that workspace. Absent when not known. */
  workspace_id?: string;
  title: string;
  body: string;
  tag: string;
}
