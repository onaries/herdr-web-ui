import { describe, expect, it } from "bun:test";

import { isReportableWindowError } from "./uncaughtErrors.ts";

describe("isReportableWindowError", () => {
  it("skips the browser's ResizeObserver loop notice", () => {
    expect(isReportableWindowError(null, "ResizeObserver loop completed with undelivered notifications.")).toBe(false);
    expect(isReportableWindowError(undefined, "ResizeObserver loop limit exceeded")).toBe(false);
    expect(isReportableWindowError(null, "Uncaught ResizeObserver loop completed with undelivered notifications.")).toBe(false);
  });

  it("reports a thrown error and any other message", () => {
    expect(isReportableWindowError(new Error("ResizeObserver loop limit exceeded"), "ResizeObserver loop limit exceeded")).toBe(true);
    expect(isReportableWindowError(null, "Script error.")).toBe(true);
    expect(isReportableWindowError(null, "Uncaught TypeError: x is undefined")).toBe(true);
  });
});
