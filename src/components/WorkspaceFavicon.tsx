import { useEffect, useState, type ReactNode } from "react";

import { ApiError } from "../lib/api.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { faviconKey, probeFavicon } from "../lib/projectFavicon.ts";

/**
 * The project's own icon in place of `fallback`, when its folder keeps one. The folder is probed
 * once per session through that PC's /api/fs/stat; with no icon (or one that will not draw) the
 * fallback stays exactly as it was.
 */
export function WorkspaceFavicon({ root, fallback }: { root: string | null; fallback: ReactNode }) {
  const machineId = useMachineId();
  const { fetchFileInfo, fileUrl } = useMachineApi();
  const [found, setFound] = useState<{ root: string; path: string } | null>(null);
  const [broken, setBroken] = useState<string | null>(null);

  useEffect(() => {
    if (root === null) return;
    let live = true;
    void probeFavicon(faviconKey(machineId, root), root, async (path) => {
      try {
        const info = await fetchFileInfo(path, null);
        return "kind" in info && info.kind === "image";
      } catch (error) {
        // the PC answered that the file is not there: a miss to remember. Anything else (offline,
        // a bridge error) is no answer, and the probe forgets it
        if (error instanceof ApiError && error.status < 500) return false;
        throw error;
      }
    }).then((path) => { if (live && path !== null) setFound({ root, path }); });
    return () => { live = false; };
    // the probe is cached per folder: a new function identity is no reason to ask again
  }, [root, machineId]);

  if (root === null || found === null || found.root !== root || broken === found.path) return <>{fallback}</>;
  return <span className="sidebar-mark workspace-favicon" aria-hidden="true"><img src={fileUrl(found.path, null)} alt="" width={16} height={16} onError={() => setBroken(found.path)} /></span>;
}
