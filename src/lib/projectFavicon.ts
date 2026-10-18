/**
 * Where a project keeps its icon, best first; each is tried once per folder for the session. A
 * site's favicon leads; then the icons frameworks and app builders keep (Next.js app/, Electron's
 * build/ and resources/, Expo and Flutter assets/), then a square logo, which may be a wordmark.
 */
export const FAVICON_CANDIDATES = [
  "favicon.svg", "favicon.ico", "favicon.png",
  "public/favicon.svg", "public/favicon.ico", "public/favicon.png",
  "static/favicon.svg", "static/favicon.ico", "static/favicon.png",
  "app/icon.svg", "app/icon.png", "app/favicon.ico",
  "src/app/icon.svg", "src/app/icon.png", "src/app/favicon.ico",
  "public/icon.svg", "public/icon.png", "public/apple-touch-icon.png",
  "icon.svg", "icon.png", "build/icon.png", "resources/icon.png", "assets/icon.png",
  "logo.svg", "logo.png", "assets/logo.svg", "assets/logo.png", "public/logo.svg", "public/logo.png",
  "src/assets/logo.svg", "src/assets/logo.png", ".github/logo.svg", ".github/logo.png",
] as const;

/** One cache entry per PC and folder: the same folder on two PCs is two projects. */
export function faviconKey(machineId: string, root: string): string {
  return `${machineId}\u0000${root}`;
}

/** Absolute, because a bare name would make the server search under the folder. */
export function faviconPath(root: string, candidate: string): string {
  return `${root.replace(/\/+$/, "")}/${candidate}`;
}

const probes = new Map<string, Promise<string | null>>();

/**
 * The best candidate `isImage` accepts, or null. The candidates are asked together, so a folder with
 * no icon costs one round trip rather than one per place. A folder is probed once: later asks (a
 * remount, another row) get the first answer back. A miss with a check that failed (the PC was not
 * reachable) is not an answer: it is forgotten, so the next ask probes again.
 */
export function probeFavicon(key: string, root: string, isImage: (path: string) => Promise<boolean>): Promise<string | null> {
  const known = probes.get(key);
  if (known) return known;
  const probe = (async () => {
    let failed = false;
    const paths = FAVICON_CANDIDATES.map((candidate) => faviconPath(root, candidate));
    const hits = await Promise.all(paths.map((path) => isImage(path).catch(() => { failed = true; return false; })));
    const best = paths[hits.indexOf(true)];
    if (best !== undefined) return best;
    if (failed) probes.delete(key);
    return null;
  })();
  probes.set(key, probe);
  return probe;
}

export function forgetFaviconProbes(): void {
  probes.clear();
}
