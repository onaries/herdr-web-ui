export type ViewportResumeEvent = "visibilitychange" | "pageshow";

export function shouldSyncViewportOnResume(
  event: ViewportResumeEvent,
  visibilityState: DocumentVisibilityState,
): boolean {
  return event === "pageshow" || visibilityState === "visible";
}
