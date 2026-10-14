/**
 * Whether this page is in use: on screen and holding the focus, the same test PaneTerminal's
 * `inUse` makes. Every PC connection tells its server (WS `presence`), and while any page is in
 * use the server sends no web push to any device (#751).
 */
export function pageInUse(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();
}

/** Calls `listener` with `pageInUse()` now and again whenever focus or visibility changes. */
export function watchPageInUse(listener: (active: boolean) => void): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  const update = (): void => listener(pageInUse());
  update();
  window.addEventListener("focus", update);
  window.addEventListener("blur", update);
  window.addEventListener("pagehide", update);
  document.addEventListener("visibilitychange", update);
  return () => {
    window.removeEventListener("focus", update);
    window.removeEventListener("blur", update);
    window.removeEventListener("pagehide", update);
    document.removeEventListener("visibilitychange", update);
  };
}
