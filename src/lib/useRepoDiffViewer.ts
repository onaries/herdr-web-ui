import { useCallback, useEffect, useRef, useState } from "react";

import { diffTargetFromState, diffTargetState, type RepoDiffTarget } from "./repoDiff.ts";

/**
 * A repository diff is a history entry above the Files list, as a file preview is (useFileViewer):
 * Android Back closes it, and a reload or Forward restores it with its PC, pane and comparison.
 */
export function useRepoDiffViewer() {
  const [viewing, setViewing] = useState(() => diffTargetFromState(window.history.state));
  const closing = useRef(false);

  useEffect(() => {
    const onPop = (event: PopStateEvent): void => {
      closing.current = false;
      setViewing(diffTargetFromState(event.state));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const openDiff = useCallback((target: RepoDiffTarget) => {
    if (closing.current) return;
    const state = diffTargetState(window.history.state, target);
    // another file of the same list replaces the entry: Back still returns to the list in one step
    if (diffTargetFromState(window.history.state)) window.history.replaceState(state, "");
    else window.history.pushState(state, "");
    setViewing(target);
  }, []);

  const closeDiff = useCallback(() => {
    if (closing.current) return;
    if (diffTargetFromState(window.history.state)) {
      closing.current = true;
      window.history.back();
    } else setViewing(null);
  }, []);

  /** Hand the current entry to another viewer without traversing back to the list. */
  const releaseDiff = useCallback(() => {
    window.history.replaceState(diffTargetState(window.history.state, null), "");
    setViewing(null);
  }, []);

  return { viewing, openDiff, closeDiff, releaseDiff };
}
