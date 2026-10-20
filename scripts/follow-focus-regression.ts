/**
 * Settings → Terminal → Follow herdr's focus (#311) against a real herdr: a tab herdr opens and
 * brings to the front by itself (`herdr tab create --focus`, as a script does) is opened here only
 * once this device asked for it, and herdr's focus moving back brings this device back too.
 * Imported by ui-regression.ts, with Settings closed; it ends on the pane selected when it began
 * and with the setting off.
 */
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { herdrRpc, tabClose } from "../server/herdr/client.ts";
import { openSettingsPage } from "./settings-page.ts";

export interface FollowFocusFixture {
  /** a workspace to open the check's tabs in: they are closed again, its own panes are left alone */
  workspaceId: string;
}

/** how long a focus change that must not move the selection gets to move it */
const NO_FOLLOW_WAIT_MS = 600;

export async function checkFollowHerdrFocus(page: Page, fixture: FollowFocusFixture): Promise<void> {
  const until = async (check: () => Promise<boolean>, label: string): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (!(await check())) {
      assert.ok(Date.now() < deadline, `Timed out: ${label}`);
      await page.waitForTimeout(50);
    }
  };
  const selectedPaneId = () => page.evaluate(() => JSON.parse(sessionStorage.getItem("herdr-web-ui:selection") ?? "null")?.pane_id as string | undefined);
  const shownTab = () => page.locator(".tab-strip").getByRole("tab", { selected: true }).textContent();
  const follow = async (on: boolean): Promise<void> => {
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Terminal");
    const toggle = page.getByRole("switch", { name: "Follow herdr's focus", exact: true });
    if ((await toggle.getAttribute("aria-checked")) !== String(on)) await toggle.click();
    assert.equal(await toggle.getAttribute("aria-checked"), String(on));
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
  };
  // `herdr tab create --focus`: herdr opens the tab and moves its own focus there, past this app
  const focusedTab = (label: string) => herdrRpc<{ tab: { tab_id: string }; root_pane: { pane_id: string } }>(
    "tab.create", { workspace_id: fixture.workspaceId, label, focus: true });

  const before = await selectedPaneId();
  assert.ok(before, "a pane is selected before the check");
  const tabs: string[] = [];
  try {
    // off, as it starts: herdr's focus is herdr's, and this device stays where it is
    const ignored = await focusedTab("follow focus off");
    tabs.push(ignored.tab.tab_id);
    // fixed wait: proving that the selection does not move
    await page.waitForTimeout(NO_FOLLOW_WAIT_MS);
    assert.equal(await selectedPaneId(), before, "a device that did not ask to follow herdr's focus keeps its pane");

    await follow(true);
    const followed = await focusedTab("follow focus on");
    tabs.push(followed.tab.tab_id);
    await until(async () => await selectedPaneId() === followed.root_pane.pane_id, "the tab herdr brought to the front opens here");
    // a pane the roster had not listed yet stays open once it does, its tab the one shown
    await until(async () => (await shownTab())?.includes("follow focus on") === true, "the new tab is the one shown");
    assert.equal(await selectedPaneId(), followed.root_pane.pane_id, "the followed pane stays selected once the roster lists it");

    // herdr's focus goes back where this device was: so does this device
    await herdrRpc("pane.focus", { pane_id: before });
    await until(async () => await selectedPaneId() === before, "herdr's focus moving back brings this device back");
    await follow(false);
    console.log("PASS herdr's focus is followed only once this device asks for it, to a new tab and back");
  } finally {
    for (const tab of tabs) await tabClose(tab).catch(() => undefined);
  }
}
