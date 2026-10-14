/**
 * Which window "error" events main.tsx reports as uncaught errors. Browsers fire one for a
 * ResizeObserver whose callback resized what it observes ("ResizeObserver loop completed with
 * undelivered notifications" in Chrome, "ResizeObserver loop limit exceeded" in older ones): the
 * notifications simply wait for the next frame, nothing threw, so it is not a bug to report.
 */
export function isReportableWindowError(error: unknown, message: string): boolean {
  if (error != null) return true;
  return !/^(?:Uncaught )?ResizeObserver loop (?:completed with undelivered notifications|limit exceeded)/.test(message);
}
