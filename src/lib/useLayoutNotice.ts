import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { routeMissing } from "./api.ts";
import type { Translate } from "./i18n.ts";

/** Keeps the transient notice for refused layout calls. */
export function useLayoutNotice() {
  // a palette layout call a PC's bridge could not take: a line over the pane, gone after a moment as the tab strip's is
  const [layoutNotice, setLayoutNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!layoutNotice) return;
    const timer = window.setTimeout(() => setLayoutNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [layoutNotice]);
  return { layoutNotice, setLayoutNotice };
}

/** Creates the callback for layout calls refused by a bridge. */
export function useLayoutRefused(setLayoutNotice: Dispatch<SetStateAction<string | null>>, t: Translate) {
  // a layout call the palette made and the PC refused: a bridge from before the route says so
  // over the pane (the tab's own menu has a line of its own); anything else is logged, as
  // other background failures are
  const layoutRefused = useCallback((what: string, err: unknown): void => {
    if (routeMissing(err)) setLayoutNotice(t("This PC's bridge does not offer this yet"));
    else console.warn(what, err);
  }, [t]);
  return layoutRefused;
}
