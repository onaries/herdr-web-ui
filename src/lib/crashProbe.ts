/**
 * A test hook that makes one part of the app throw while it renders, so a browser script can see
 * the error boundaries catch it (scripts/render-crash-demo-regression.ts). The flag is a build-time
 * constant: only the browser lane's demo build (scripts/demo-build.ts) sets it, so `bun run build`
 * and the published demo drop the check altogether.
 */
declare const __HERDR_TEST_HOOKS__: boolean;

export type CrashRegion = "root" | "sidebar" | "pane" | "settings";

/** Throws when the address asks this region to (`?crash=sidebar`) in a build with test hooks. */
export function crashProbe(region: CrashRegion): void {
  if (__HERDR_TEST_HOOKS__ && new URLSearchParams(window.location.search).get("crash") === region) {
    throw new Error(`crash probe: ${region}`);
  }
}
