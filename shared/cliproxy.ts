/** CLIProxyAPI management configuration: the management key never leaves the server. */
export interface CLIProxyStatus {
  readonly configured: boolean;
  readonly url: string;
  readonly ok: boolean;
  readonly problem: string | null;
}
export type CLIProxyProvider = "claude" | "codex";
export interface CLIProxyLogin {
  readonly url: string;
  readonly state: string;
}
export interface CLIProxyLoginStatus {
  readonly status: "wait" | "ok" | "error";
}
