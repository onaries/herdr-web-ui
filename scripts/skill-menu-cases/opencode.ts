import assert from "node:assert/strict";
import type { SlashCommand } from "../../shared/protocol.ts";
import { agentBuiltins, type CaseRun } from "../skill-menu-case.ts";

export const agent = "opencode";
export const commands: SlashCommand[] = [
  ...agentBuiltins(agent),
  { name: "check", description: "Check the project before release", source: "project" },
  { name: "pdf-tools", description: "Extracts text and tables from PDF files. Use when a PDF is attached; scanned pages need OCR first.", source: "skill", origin: "user" },
  { name: "docs-release", description: "Writes release notes from the project's merged changes. Use when preparing a release.", source: "skill", origin: "project" },
  { name: "customize-opencode", description: "Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. Also use when creating or fixing opencode agents, subagents, skills, plugins, MCP servers, or permission rules.", source: "skill", origin: "bundled" },
];
export const turnText = "/pdf-tools hello";
export const chips = ["/pdf-tools"];

export const expect = async ({ page, width, box, menu, scenario, clear, rowNames, rowLabels, menuFits, rowsBrief, chipGeometry }: CaseRun): Promise<void> => {
  await scenario(`OpenCode slash menu and origins (${width}px)`, `menu-${width}.png`, async (capture) => {
    await box.fill("/");
    await menu.locator(".menu-item").first().waitFor();
    assert.deepEqual((await rowNames()).sort(), commands.map((row) => row.name).sort());
    assert.deepEqual(await menu.locator(".menu-heading").allTextContents(), ["Built in", "Project", "Your skills", "Project skills", "Built-in skills", "Terminal commands"]);
    await menuFits("OpenCode menu");
    await rowsBrief("OpenCode menu");
    await menu.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await capture();
  });
  await scenario(`OpenCode selection (${width}px)`, `pick-${width}.png`, async (capture) => {
    await clear();
    await box.fill("/pdf");
    await menu.locator(".menu-item").first().waitFor();
    assert.equal((await rowLabels())[0], "/pdf-tools");
    await menuFits("OpenCode selection");
    await rowsBrief("OpenCode selection");
    await capture();
    await box.press("Enter");
    assert.equal(await box.inputValue(), "/pdf-tools ");
    await menu.waitFor({ state: "detached" });
  });
  await scenario(`OpenCode only triggers at message start (${width}px)`, `chips-${width}.png`, async (capture) => {
    for (const text of ["x $", "x /pdf"]) {
      await clear();
      await box.fill(text);
      assert.equal(await box.getAttribute("aria-expanded"), "false");
      assert.equal(await menu.count(), 0);
    }
    await clear();
    const turn = page.locator(".chat-turn-user").last();
    await turn.locator(".markdown-skill").first().waitFor();
    await turn.scrollIntoViewIfNeeded();
    const geometry = await chipGeometry();
    assert.deepEqual(geometry.chips, chips);
    assert.ok(geometry.inside && geometry.onScreen && !geometry.overlapping && !geometry.overflowing);
    await capture();
  });
};
