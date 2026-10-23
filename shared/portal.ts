/**
 * GET /api/portal: a public HTTPS address for this server through the Portal on its PC
 * (gosuda/portal-tunnel), which the app starts and stops (Settings → Phone & devices).
 */
export interface PortalStatus {
  /** false on a server started without Portal (tests, the demo): the section stays hidden */
  readonly supported: boolean;
  /** what `portal version` says of the `portal` on PATH; null when there is none or it does not answer */
  readonly version: string | null;
  /** the oldest Portal that can run this app's tunnel */
  readonly min_version: string;
  /** `version` is `min_version` or later: Start is offered */
  readonly usable: boolean;
  /** recovering: a Portal that was serving ended on its own and is started again, once, with no address meanwhile */
  readonly phase: "idle" | "starting" | "running" | "recovering" | "stopping" | "error";
  /** the relay the tunnel uses, or used last; an https origin */
  readonly relay: string | null;
  /** the public address while it runs, without the default port */
  readonly url: string | null;
  /** why a start would be refused now: no token set, or tailscale serve declared the only way in */
  readonly blocked: "token_required" | "serve_only" | null;
  /** what went wrong last; null after a success */
  readonly error: string | null;
  /** the tail of what Portal printed, for when the error alone does not say enough */
  readonly output: string | null;
}
