import type { SlashCommand } from "../../shared/protocol.ts";
import { agentBuiltins, type CaseRun } from "../skill-menu-case.ts";

export const agent = "cmd";
export const commands: SlashCommand[] = [
  ...agentBuiltins(agent),
  { name: "component", description: "frontend · Build a component", source: "project", id: "fixture:frontend/component.md" },
];
export const turnText = "The component is ready.";
export const chips: string[] = [];
export const widths = [1280, 390] as const;
export const schemes = ["dark", "light"] as const;

export const expect = async ({ box, menu, scenario, width, scheme, menuFits, rowsBrief }: CaseRun): Promise<void> => {
  await scenario(`nested command label at ${width}px ${scheme}`, `nested-${width}-${scheme}.png`, async (capture) => {
    await box.fill("/comp");
    const row = menu.locator(".menu-item").filter({ hasText: "component" });
    await row.waitFor();
    if (await row.locator(".menu-item-main").textContent() !== "/component") throw new Error("nested command name includes its folder or trigger");
    if (await row.locator(".menu-item-hint").textContent() !== "Project · frontend · Build a component") throw new Error("nested folder label or command description is missing");
    await menuFits("nested command");
    await rowsBrief("nested command");
    await capture();
  });
};
