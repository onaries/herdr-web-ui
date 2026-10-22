import assert from "node:assert/strict";
import { join } from "node:path";
import type { Page, Locator } from "playwright-core";

/** The owned fixture directory has only a and b; no workspace is created by this check. */
export async function checkFolderFilter(page: Page, dialog: Locator, createRequests: () => number): Promise<void> {
  const until = async (check: () => Promise<boolean>, label: string) => {
    const deadline = Date.now() + 5_000;
    while (!(await check())) {
      assert.ok(Date.now() < deadline, label);
      await page.waitForTimeout(50);
    }
  };
  await dialog.getByRole("button", { name: "Browse", exact: true }).click();
  const filter = dialog.getByRole("searchbox", { name: "Filter folders" });
  await filter.waitFor();
  await filter.fill("A");
  await until(async () => (await dialog.locator(".dir-browser-item").allTextContents()).join() === "a", "case-insensitive folder filter");
  const composition = await filter.evaluate((input) => [
    { key: "Enter", isComposing: true },
    { key: "Enter", keyCode: 229 },
    { key: "Escape", isComposing: true },
  ].map((init) => input.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true }))));
  assert.deepEqual(composition, [true, true, true], "IME candidate keys keep their default action");
  assert.equal(await filter.inputValue(), "A", "IME Escape does not clear the filter");
  assert.equal(await dialog.isVisible(), true, "IME Escape does not close the dialog");
  assert.equal(await filter.evaluate((input) => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))), false, "plain Enter cannot submit the form");
  assert.equal(createRequests(), 0, "filter keys create no workspace");
  await filter.fill("no-matching-folder");
  await dialog.getByText("No matching folders", { exact: true }).waitFor();
  await filter.press("Escape");
  assert.equal(await filter.inputValue(), "");
  assert.equal(await dialog.isVisible(), true, "Escape clears before closing");
  await filter.fill("a");
  await dialog.locator(".dir-browser-item").click();
  await until(async () => (await filter.inputValue()) === "", "navigation clears the filter");
  const directory = dialog.getByLabel(/^Directory/);
  // Browse writes the opened folder into Directory, so Start would use it without Use this folder
  await until(async () => {
    const value = await directory.inputValue();
    return value.endsWith("/a") || value === "a";
  }, "Directory follows the folder Browse opened");
  await dialog.getByRole("button", { name: "Parent folder", exact: true }).click();
  await until(async () => {
    const value = await directory.inputValue();
    return !value.endsWith("/a") && value !== "a";
  }, "Directory follows Browse back to the parent");
  await dialog.getByRole("button", { name: "Use this folder", exact: true }).click();
  await filter.waitFor({ state: "detached" });
  // a typed path that does not open shows home in its place, and Directory keeps what was typed:
  // Start must refuse the typo, not start in home. Closing Browse is a new event, so React has run
  // the listing's effects by the time the value is read.
  const typo = "~/ovis-no-such-folder";
  const picked = await directory.inputValue();
  await directory.fill(typo);
  await dialog.getByRole("button", { name: "Browse", exact: true }).click();
  // until the listing comes, the path bar shows the typed path itself: wait for home in its place
  await until(async () => !["", typo].includes((await dialog.locator(".dir-browser-path").textContent()) ?? ""), "Browse shows home for a path that does not open");
  await dialog.getByRole("button", { name: "Browse", exact: true }).click();
  await filter.waitFor({ state: "detached" });
  assert.equal(await directory.inputValue(), typo, "Browse's home in place of a typo does not replace the typed Directory");
  // the checks after this one browse the owned fixture folder again
  await directory.fill(picked);
  console.log("PASS folder filtering preserves IME keys, blocks form submission and clears on navigation");
}

/**
 * New folder, with Browse open on a folder the test owns: Escape closes only the name field, a
 * refused name says so in place and submits nothing, and a made folder opens so Directory follows it.
 */
export async function checkNewFolder(page: Page, dialog: Locator, createRequests: () => number, name: string): Promise<void> {
  const until = async (check: () => Promise<boolean>, label: string) => {
    const deadline = Date.now() + 5_000;
    while (!(await check())) {
      assert.ok(Date.now() < deadline, label);
      await page.waitForTimeout(50);
    }
  };
  const directory = dialog.getByLabel(/^Directory/);
  const before = await directory.inputValue();
  const button = dialog.getByRole("button", { name: "New folder", exact: true });
  const field = dialog.getByRole("textbox", { name: "New folder name" });
  await button.click();
  await field.waitFor();
  assert.equal(await field.evaluate((input) => input === document.activeElement), true, "the name field takes focus");
  await field.press("Escape");
  await field.waitFor({ state: "detached" });
  assert.equal(await dialog.isVisible(), true, "Escape closes the field, not the dialog");
  await button.click();
  await field.fill("a/b");
  await field.press("Enter");
  await dialog.getByRole("alert").filter({ hasText: "That name cannot be a folder name." }).waitFor();
  assert.equal(createRequests(), 0, "Enter in the name field starts no workspace");
  assert.equal(await directory.inputValue(), before, "a refused name leaves Directory alone");
  assert.equal(await field.evaluate((input) => input === document.activeElement), true, "a refused name keeps the field focused to retype");
  await field.fill(name);
  if (process.env.UI_EVIDENCE_DIR) {
    await dialog.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "new-folder-desktop.png") });
    const size = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "new-folder-mobile.png") });
    if (size) await page.setViewportSize(size);
  }
  await field.press("Enter");
  await field.waitFor({ state: "detached" });
  await until(async () => (await directory.inputValue()).endsWith(`/${name}`), "Directory follows the folder New folder made");
  assert.equal(await dialog.locator(".dir-browser-path").textContent(), await directory.inputValue(), "Browse shows the folder it made");
  assert.equal(createRequests(), 0, "making a folder starts no workspace");
  console.log("PASS New folder makes a folder in the one shown, opens it, and keeps Escape and Enter to itself");
}
