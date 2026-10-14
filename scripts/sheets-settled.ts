import type { Page } from "playwright-core";

/**
 * Resolves once no phone sheet is still rising (src/lib/sheets.ts). A sheet rises over --dur-sheet,
 * so a check that measures one the moment it opens reads it short of where it comes to rest. A
 * closed sheet's drop is drawn in a closed shadow root, out of every query's reach.
 */
export async function sheetsSettled(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"
    || !/^(?:sheet|scrim)-in$/.test((animation as CSSAnimation).animationName ?? "")), undefined, { timeout: 5_000 });
}
