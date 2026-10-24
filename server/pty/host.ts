import { existsSync } from "node:fs";
import { join } from "node:path";

/** Where `cargo build --release` in crates/pty-sidecar puts the Rust PTY host. */
export const RUST_SIDECAR_BUILD = join(import.meta.dir, "..", "..", "crates", "pty-sidecar", "target", "release", "ovis-pty-sidecar");

let warned = false;

/**
 * The Rust PTY host to run, when OVIS_PTY_SIDECAR=rust asks for it (OVIS_PTY_SIDECAR_BIN, else the release
 * build): it takes pty-host.mjs's arguments and frames. Null otherwise, on Windows, or when the binary is
 * missing, which is said once.
 */
export function rustSidecar(env: Record<string, string | undefined> = process.env): string | null {
  if (env["OVIS_PTY_SIDECAR"] !== "rust" || process.platform === "win32") return null;
  const binary = env["OVIS_PTY_SIDECAR_BIN"] || RUST_SIDECAR_BUILD;
  if (existsSync(binary)) return binary;
  if (!warned) {
    warned = true;
    console.error(`OVIS_PTY_SIDECAR=rust: ${binary} does not exist (cargo build --release in crates/pty-sidecar); using the Node PTY sidecar`);
  }
  return null;
}

/** The PTY host's command before its own arguments: the Rust host when asked for and built, else `node <script>`. */
export function ptyHost(nodeScript: string, env: Record<string, string | undefined> = process.env): string[] {
  const rust = rustSidecar(env);
  return rust ? [rust] : ["node", nodeScript];
}
