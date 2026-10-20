import assert from "node:assert/strict";
import { agentBuiltins, type CaseRun } from "../skill-menu-case.ts";

export const agent = "dsh-tui";
export const commands = agentBuiltins(agent);
export const turnText = "Check this example without running a command.";
export const chips: string[] = [];

export const expect = async ({ page, width, box, menu, scenario, clear, rowNames, menuFits, rowsBrief, submits }: CaseRun): Promise<void> => {
  for (const theme of ["light", "dark"]) await scenario(`dsh completion and explicit-send boundary ${width} ${theme}`, `menu-${width}-${theme}.png`, async (capture) => {
    const sentAt = (await submits()).length;
    await clear();
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    await box.fill("/");
    await menu.locator(".menu-item").first().waitFor();
    assert.ok((await rowNames()).includes("restart"));
    assert.equal((await rowNames()).length, commands.length);
    await menuFits("dsh commands");
    await rowsBrief("dsh commands");
    await box.fill("/comp");
    await menu.getByText("/compact", { exact: true }).waitFor();
    assert.deepEqual(await rowNames(), ["compact"]);
    await capture();
    if (width === 390) await menu.getByText("/compact", { exact: true }).tap();
    else await box.press("Tab");
    assert.equal(await box.inputValue(), "/compact ");
    await menu.waitFor({ state: "detached" });
    await box.fill("/resta");
    await menu.getByText("/restart", { exact: true }).waitFor();
    await box.press("ArrowDown");
    await box.press("ArrowUp");
    await box.press("Enter");
    assert.equal(await box.inputValue(), "/restart ");
    await menu.waitFor({ state: "detached" });
    assert.deepEqual((await submits()).slice(sentAt), []);
    await box.fill("/mod");
    await menu.getByText("/model", { exact: true }).waitFor();
    await box.press("Escape");
    await menu.waitFor({ state: "detached" });
    assert.equal(await box.inputValue(), "/mod");
    await box.fill("/status ");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.waitForFunction((from) => Reflect.get(window, "sentSubmits").length > from, sentAt);
    assert.deepEqual((await submits()).slice(sentAt), ["/status "]);
  });
};
