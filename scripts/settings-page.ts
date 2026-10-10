import type { Page } from "playwright-core";

/**
 * Settings shows one page at a time: opens the one a check needs, in a dialog that is already
 * open or opening. A phone lists the pages first, and from another page the way there is back.
 */
export async function openSettingsPage(page: Page, name: string, backName = "Back to settings"): Promise<void> {
  const dialog = page.locator(".settings-dialog");
  await dialog.waitFor();
  const tab = dialog.getByRole("tab", { name, exact: true });
  if (await tab.count() === 0) await dialog.getByRole("button", { name: backName, exact: true }).click();
  await tab.click();
  await dialog.getByRole("tabpanel", { name, exact: true }).waitFor();
}
