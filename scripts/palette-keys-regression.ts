/**
 * The command palette's picker keys against a roster that changes under them: a filter letter
 * that names the filter already shown, and panes that leave the filter while the keyboard is on
 * the list, or enter it before the row the keyboard is on. Imported by ui-regression.ts, with the
 * palette closed.
 */
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { herdrRpc, tabClose, tabCreate } from "../server/herdr/client.ts";

export interface PaletteKeysFixture {
  /** a workspace to open the four panes of the check in: their tabs are closed again, its own panes are left alone */
  workspaceId: string;
}

/**
 * Reports a status only for the panes it opens, so the suite's fixture panes keep theirs, and ends
 * on the pane that was selected when it began.
 */
export async function checkPaletteKeys(page: Page, fixture: PaletteKeysFixture): Promise<void> {
  const until = async (check: () => Promise<boolean>, label: string): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (!(await check())) {
      assert.ok(Date.now() < deadline, `Timed out: ${label}`);
      await page.waitForTimeout(50);
    }
  };
  const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
  const search = palette.getByRole("searchbox", { name: "Search panes and actions", exact: true });
  const chip = (status: string) => palette.locator(`.palette-filter[data-status="${status}"]`);
  const rows = palette.locator(".palette-pane");
  const titleAt = (index: number) => palette.locator(`#palette-item-${index} .palette-row-title`).textContent();
  const focusedId = () => page.evaluate(() => (document.activeElement === document.body ? "body" : document.activeElement?.id ?? ""));
  const pickedId = () => search.getAttribute("aria-activedescendant");
  const report = (pane: string, state: string) => herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "codex", state });
  const selectedPaneId = () => page.evaluate(() => JSON.parse(sessionStorage.getItem("herdr-web-ui:selection") ?? "null")?.pane_id as string | undefined);
  const selectedBefore = await selectedPaneId();
  assert.ok(selectedBefore, "a pane is selected before the check");

  const names = ["palette keys C", "palette keys D", "palette keys E", "palette keys F"];
  const tabs: Array<{ tab: { tab_id: string }; root_pane: { pane_id: string } }> = [];
  try {
    for (const name of names) {
      const created = await tabCreate({ workspaceId: fixture.workspaceId });
      tabs.push(created);
      await herdrRpc("pane.rename", { pane_id: created.root_pane.pane_id, label: name });
    }
    const [paneC, paneD, paneE, paneF] = tabs.map((created) => created.root_pane.pane_id) as [string, string, string, string];
    for (const pane of [paneC, paneD, paneE, paneF]) await report(pane, "working");
    await page.keyboard.press("ControlOrMeta+Shift+k");
    await palette.waitFor();
    await until(() => search.evaluate((input) => document.activeElement === input), "palette search takes focus");
    await until(async () => await chip("working").locator(".palette-filter-count").textContent() === "4", "RUN counts the four working panes");

    // a letter naming the filter already shown still puts the focus on the first row: the row the
    // footer describes is the one Enter would run
    await palette.locator("#palette-item-1").focus();
    await until(async () => await pickedId() === "palette-item-1", "a focused row is the pick");
    await page.keyboard.press("a");
    await until(async () => await focusedId() === "palette-item-0" && await pickedId() === "palette-item-0",
      "`a` over the list with All shown puts the focus and the pick on the first row");

    // RUN by its letter: C, D, E and F in their tabs' order, the keyboard on the second row
    await page.keyboard.press("w");
    await until(async () => await chip("working").getAttribute("aria-checked") === "true" && await rows.count() === 4, "RUN shows the four working panes");
    await until(async () => await focusedId() === "palette-item-0", "a filter letter puts the focus on the first row");
    assert.deepEqual(await Promise.all([0, 1, 2, 3].map(titleAt)), names, "RUN lists the four panes in their tabs' order");
    await page.keyboard.press("ArrowDown");
    await until(async () => await focusedId() === "palette-item-1" && await pickedId() === "palette-item-1", "ArrowDown over the list moves the focus and the pick together");

    // the pane before the pick leaves the filter: the pick and the focus stay on the same row
    await report(paneC, "idle");
    await until(async () => await rows.count() === 3, "C left RUN");
    assert.equal(await focusedId(), "palette-item-0", "the focused row keeps the focus at its new place");
    assert.equal(await pickedId(), "palette-item-0", "the pick follows the focused row up the list");
    assert.equal(await titleAt(0), names[1], "the row at the pick is still the one the keyboard was on");

    // the picked row leaves: the row now at its place takes the focus (the one that stood right
    // after it, not the one at the place the pick had before the roster moved it), and the keys
    // still reach the palette
    await report(paneD, "idle");
    await until(async () => await rows.count() === 2, "D left RUN");
    assert.equal(await titleAt(0), names[2], "the row after the one that left stands at its place");
    await until(async () => await focusedId() === "palette-item-0" && await pickedId() === "palette-item-0", "the row now at the pick's place takes the focus");
    await page.keyboard.press("a");
    await until(async () => await chip("all").getAttribute("aria-checked") === "true", "a filter letter still reaches the palette");
    await until(async () => await focusedId() === "palette-item-0", "and puts the focus on the first row again");

    // the rows under a filter leave one by one: the focus is handed on, then to the search
    await page.keyboard.press("w");
    await until(async () => await rows.count() === 2 && await focusedId() === "palette-item-0", "RUN shows the two working panes, the focus on the first");
    await report(paneE, "idle");
    await until(async () => await rows.count() === 1, "E left RUN");
    await until(async () => await focusedId() === "palette-item-0" && await pickedId() === "palette-item-0", "the last row takes the focus");
    assert.equal(await titleAt(0), names[3], "the last row is the last pane");
    await report(paneF, "idle");
    await until(async () => await rows.count() === 0, "F left RUN");
    await until(() => search.evaluate((input) => document.activeElement === input), "an emptied list hands the focus to the search");

    // the letter pressed again on the first row, then a pane before it enters the filter: the
    // keyboard stays on its row, and the highlight and Enter name that row (a letter that moves
    // no focus fires no focus event, so the pick must be told without one)
    await report(paneD, "working");
    await report(paneE, "working");
    await until(async () => await rows.count() === 2, "D and E are back in RUN");
    await palette.locator("#palette-item-0").focus();
    await until(async () => await focusedId() === "palette-item-0" && await pickedId() === "palette-item-0", "the first row has the focus and the pick");
    await page.keyboard.press("w");
    await until(async () => await focusedId() === "palette-item-0" && await pickedId() === "palette-item-0", "`w` on the first row keeps the focus and the pick there");
    await report(paneC, "working");
    await until(async () => await rows.count() === 3, "C entered RUN");
    assert.equal(await titleAt(1), names[1], "C stands before the row the keyboard is on");
    assert.equal(await focusedId(), "palette-item-1", "the focused row keeps the focus at its new place");
    assert.equal(await pickedId(), "palette-item-1", "the pick stays on the focused row, not on the row that entered before it");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-selected")), "true", "the focused row is the highlighted one");
    await page.keyboard.press("Enter");
    await palette.waitFor({ state: "hidden" });
    await until(async () => await selectedPaneId() === paneD, "Enter runs the row the keyboard was on");
    // back to the pane selected before: the suite's next steps read its sidebar row
    await page.locator(`.pane-select[title^="${selectedBefore} —"]`).click();
    await until(async () => await selectedPaneId() === selectedBefore, "the selection returns to the pane selected before the check");
    console.log("PASS palette keys: a repeated filter letter refocuses the first row, the pick survives panes leaving and entering the filter, and Enter runs the focused row");
  } finally {
    for (const created of tabs.reverse()) await tabClose(created.tab.tab_id).catch(() => undefined);
  }
}
