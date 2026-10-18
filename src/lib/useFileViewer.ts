import { useCallback, useEffect, useRef, useState } from "react";
import { outsideSettings } from "./settingsHistory.ts";
import type { FilePresentation } from "./filePresentation.ts";

interface FilePreview {
  path: string;
  paneId: string | null;
  machineId: string;
  presentation?: FilePresentation;
}
const HISTORY_KEY = "herdr-web-ui:file-preview";

function previewFromState(state: unknown): FilePreview | null {
  if (state === null || typeof state !== "object") return null;
  const preview = (state as Record<string, unknown>)[HISTORY_KEY];
  if (preview === null || typeof preview !== "object") return null;
  const value = preview as Record<string, unknown>;
  return typeof value.path === "string" && typeof value.machineId === "string" &&
    (value.paneId === null || typeof value.paneId === "string") ? {
      path: value.path, machineId: value.machineId, paneId: value.paneId,
      ...(value.presentation === "panel" || value.presentation === "popup" ? { presentation: value.presentation } : {}),
    } : null;
}

/**
 * Back to the entry under the preview's, where the system Back button goes. A page the viewer
 * frames (an HTML file) that navigates inside its frame (a click on an anchor to #details, a
 * script setting location.hash once it has loaded) puts entries of its own above the preview's in
 * the session history: history.back() then steps the frame, and this window gets no popstate
 * (#1203). The Navigation API lists this window's own entries alone, so the one under the current
 * entry is the chat's whatever the frame did, and the browser works out the steps to it. A browser
 * without it (Safari before 26.2, Firefox before 147) steps back one, as before.
 */
function backUnderPreview(): Promise<unknown> | undefined {
  const navigation = window.navigation as Navigation | undefined;
  const index = navigation?.currentEntry?.index ?? 0;
  const below = navigation?.entries()[index - 1];
  if (navigation === undefined || below === undefined) { window.history.back(); return undefined; }
  return navigation.traverseTo(below.key).committed;
}

/** Android Back traverses history: a preview must be an entry above the chat, not just a modal. */
export function useFileViewer() {
  const [viewing, setViewing] = useState(() => previewFromState(window.history.state));
  const closing = useRef(false);

  useEffect(() => {
    const onPop = (event: PopStateEvent): void => {
      closing.current = false;
      // Forward restores the preview with its original PC/pane, including after reload.
      setViewing(previewFromState(event.state));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const openFile = useCallback((preview: FilePreview, replace = false) => {
    if (closing.current) return;
    // a preview opened over Settings is no entry of Settings: a reload on it closes Settings and keeps the file
    const state = { ...outsideSettings(window.history.state), [HISTORY_KEY]: preview };
    // Choosing a different file inside an open preview must not add another Back step.
    if (replace || previewFromState(window.history.state)) window.history.replaceState(state, "");
    else window.history.pushState(state, "");
    setViewing(preview);
  }, []);

  const closeFile = useCallback(() => {
    if (closing.current) return;
    if (previewFromState(window.history.state)) {
      closing.current = true;
      // X, Escape and scrim clicks consume the same entry as the system Back button. A traversal
      // the browser refuses lands nowhere and fires no popstate: the latch is let go for the next click.
      backUnderPreview()?.catch(() => { closing.current = false; });
    } else setViewing(null);
  }, []);

  const setPresentation = useCallback((presentation: FilePresentation) => {
    const preview = previewFromState(window.history.state);
    if (closing.current || preview === null || preview.presentation === presentation) return;
    const next = { ...preview, presentation };
    window.history.replaceState({ ...window.history.state, [HISTORY_KEY]: next }, "");
    setViewing(next);
  }, []);

  /** Hands the file's entry to a move to another pane: the file leaves it without a traversal, and the viewer closes. */
  const releaseFile = useCallback(() => {
    const { [HISTORY_KEY]: _, ...rest } = (window.history.state ?? {}) as Record<string, unknown>;
    window.history.replaceState(rest, "");
    setViewing(null);
  }, []);

  return { viewing, openFile, closeFile, setPresentation, releaseFile };
}
