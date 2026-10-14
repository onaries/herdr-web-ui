/** Where a project keeps its icon, best first; each is tried once per folder for the session. */
export const FAVICON_CANDIDATES = ["favicon.svg", "favicon.ico", "favicon.png", "public/favicon.svg", "public/favicon.ico", "public/favicon.png"] as const;

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
 * The first candidate `isImage` accepts, or null. A folder is probed once: later asks (a remount,
 * another row) get the first answer back. A miss with a check that failed (the PC was not
 * reachable) is not an answer: it is forgotten, so the next ask probes again.
 */
export function probeFavicon(key: string, root: string, isImage: (path: string) => Promise<boolean>): Promise<string | null> {
  const known = probes.get(key);
  if (known) return known;
  const probe = (async () => {
    let failed = false;
    for (const candidate of FAVICON_CANDIDATES) {
      const path = faviconPath(root, candidate);
      if (await isImage(path).catch(() => { failed = true; return false; })) return path;
    }
    if (failed) probes.delete(key);
    return null;
  })();
  probes.set(key, probe);
  return probe;
}

export function forgetFaviconProbes(): void {
  probes.clear();
}
