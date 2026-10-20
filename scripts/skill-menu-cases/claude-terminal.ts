import assert from "node:assert/strict";
import type { SlashCommand } from "../../shared/protocol.ts";
import type { CaseRun } from "../skill-menu-case.ts";

// A Claude pane whose catalog says which commands run in the terminal (visibility, or a bare
// form whose interaction is the terminal) and which rows Claude's own menu hides: the terminal
// group, its badge, the two ways on that keep the draft, and a hidden row typed by hand.
export const agent = "claude";
const builtin = (name: string, description: string, rest: Partial<SlashCommand> = {}): SlashCommand => ({ name, description, source: "builtin", ...rest });
export const commands: SlashCommand[] = [
  builtin("compact", "Compact conversation context", { forms: [{ match: "bare", interaction: "none" }, { match: "other", interaction: "none" }] }),
  builtin("config", "Open configuration", { visibility: "terminal", forms: [{ match: "bare", interaction: "terminal" }] }),
  builtin("cost", "Show token usage and cost", { forms: [{ match: "bare", interaction: "terminal" }] }),
  builtin("doctor", "Check the installation", { forms: [{ match: "bare", interaction: "terminal" }] }),
  builtin("help", "Show available commands. Lists every command with its description.", { forms: [{ match: "bare", interaction: "terminal" }] }),
  builtin("model", "Choose a model", { forms: [{ match: "bare", interaction: "dialog", dialog: "model" }, { match: "other", interaction: "none" }] }),
  builtin("status", "Show session status", { forms: [{ match: "bare", interaction: "terminal" }] }),
  builtin("terminal-setup", "Configure terminal integration", { forms: [{ match: "bare", interaction: "terminal" }] }),
  builtin("heapdump", "Write a heap snapshot", { visibility: "agent-hidden", forms: [{ match: "bare", interaction: "terminal" }] }),
  { name: "deploy", description: "Deploy this project.", source: "skill", origin: "project" },
];
export const turnText = "/deploy staging";
export const chips = ["/deploy"];
export const widths = [1280, 390, 320] as const;
export const schemes = ["light", "dark"] as const;

const TERMINAL_ROWS = ["config", "cost", "doctor", "help", "status", "terminal-setup"];

export const expect = async ({ page, width, scheme, box, menu, scenario, clear, rowNames, menuFits, rowsBrief, submits }: CaseRun): Promise<void> => {
  const tag = `${scheme}-${width}`;
  const actions = page.getByRole("region", { name: "Terminal command" });
  const openTerminal = actions.getByRole("button", { name: "Open Terminal", exact: true });
  const runInTerminal = actions.getByRole("button", { name: "Run in Terminal", exact: true });
  const send = page.getByRole("button", { name: "Send message", exact: true });
  const chatLens = page.locator(".terminal-stack.is-chat");
  const backToChat = async (): Promise<void> => {
    await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
    await chatLens.waitFor();
  };

  await scenario(`terminal group at ${tag}`, `group-${tag}.png`, async (capture) => {
    await box.fill("/");
    await menu.locator(".menu-item").first().waitFor();
    const headings = await menu.locator(".menu-heading").allTextContents();
    assert.deepEqual(headings, ["Built in", "Project skills", "Terminal commands"]);
    // the terminal group is listed last, each row with its badge; the hidden row is nowhere
    const groups = menu.locator(".composer-menu-group");
    const last = groups.nth((await groups.count()) - 1);
    assert.deepEqual(await last.locator(".menu-item-main").allTextContents(), TERMINAL_ROWS.map((name) => `/${name}`));
    assert.equal(await last.locator(".menu-item .composer-menu-badge").count(), TERMINAL_ROWS.length);
    assert.deepEqual(await last.locator(".composer-menu-badge").allTextContents(), TERMINAL_ROWS.map(() => "Terminal"));
    assert.equal(await menu.locator(".composer-menu-badge").count(), TERMINAL_ROWS.length);
    assert.deepEqual((await rowNames()).sort(), commands.filter((command) => command.visibility !== "agent-hidden").map(({ name }) => name).sort());
    await menuFits("terminal group");
    await rowsBrief("terminal group");
    // the badge stands whole beside the name: neither is cut, whatever the width
    const cut = await menu.locator(".composer-menu-badge").evaluateAll((badges) => badges.filter((badge) => badge.scrollWidth > badge.clientWidth + 1).length);
    assert.equal(cut, 0, "no badge is cut");
    await menu.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await capture();
  });

  await scenario(`picking a terminal command keeps the draft at ${tag}`, `pick-${tag}.png`, async (capture) => {
    await clear();
    await box.fill("/conf");
    await menu.locator(".menu-item").first().waitFor();
    // /config by its name first; /terminal-setup follows, found by its description ("Configure ")
    const listed = await rowNames();
    assert.equal(listed[0], "config");
    assert.equal(await menu.locator(".menu-item .composer-menu-badge").count(), listed.filter((name) => TERMINAL_ROWS.includes(name)).length, "a typed query keeps the badge on the rows");
    await box.press("Enter");
    assert.equal(await box.inputValue(), "/config ");
    await actions.waitFor();
    await openTerminal.waitFor();
    await runInTerminal.waitFor();
    assert.deepEqual(await submits(), [], "nothing is sent by a pick");
    await capture();
    // Escape puts the row away and keeps the text; Send brings it back
    await box.press("Escape");
    await actions.waitFor({ state: "detached" });
    assert.equal(await box.inputValue(), "/config ");
    await send.click();
    await actions.waitFor();
    assert.deepEqual(await submits(), []);
    await actions.getByRole("button", { name: "Dismiss notice", exact: true }).click();
    await actions.waitFor({ state: "detached" });
  });

  await scenario(`a hand-typed terminal command is not sent at ${tag}`, `typed-${tag}.png`, async (capture) => {
    await clear();
    const turns = await page.locator(".chat-turn-user").count();
    await box.fill("/config");
    await send.click();
    await actions.waitFor();
    await menu.waitFor({ state: "detached" });
    assert.deepEqual(await submits(), [], "Send offers the terminal instead of sending");
    assert.equal(await box.inputValue(), "/config", "the draft stays as typed");
    assert.equal(await page.locator(".chat-turn-user").count(), turns, "no turn was added");
    assert.match(await actions.innerText(), /\/config runs in the terminal; the chat cannot show what it does\./u);
    // both ways on are in the Tab order, before the box: Shift+Tab reaches the dismiss, Run in Terminal, then Open Terminal
    await box.focus();
    const reached: string[] = [];
    for (let step = 0; step < 3; step += 1) {
      await page.keyboard.press("Shift+Tab");
      reached.push(await page.evaluate(() => { const active = document.activeElement as HTMLElement | null; return active?.getAttribute("aria-label") ?? active?.textContent ?? ""; }));
    }
    assert.deepEqual(reached, ["Dismiss notice", "Run in Terminal", "Open Terminal"]);
    const geometry = await actions.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const buttons = [...node.querySelectorAll<HTMLElement>("button")].map((button) => button.getBoundingClientRect());
      const card = document.querySelector<HTMLElement>(".composer-surface")!.getBoundingClientRect();
      return {
        onScreen: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
        overCard: rect.bottom <= card.top + 0.5,
        overlapping: buttons.some((a, index) => buttons.slice(index + 1).some((b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5)),
        overflowing: document.documentElement.scrollWidth > innerWidth,
      };
    });
    assert.ok(geometry.onScreen && geometry.overCard && !geometry.overlapping && !geometry.overflowing, JSON.stringify(geometry));
    await capture();
    // Enter on the focused Open Terminal shows the terminal and sends nothing; the draft waits in the chat
    await page.keyboard.press("Enter");
    await chatLens.waitFor({ state: "detached" });
    assert.deepEqual(await submits(), []);
    await backToChat();
    assert.equal(await box.inputValue(), "/config");
  });

  await scenario(`Run in Terminal sends, then shows the terminal at ${tag}`, `run-${tag}.png`, async (capture) => {
    const turns = await page.locator(".chat-turn-user").count();
    await send.click();
    await actions.waitFor();
    await runInTerminal.click();
    await chatLens.waitFor({ state: "detached" });
    assert.deepEqual(await submits(), ["/config"], "the usual send path carried the command");
    await backToChat();
    assert.equal(await box.inputValue(), "", "the sent text left the box");
    await page.locator(".chat-turn-user").nth(turns).waitFor();
    await capture();
  });

  await scenario(`a hand-typed hidden command is sent like any text at ${tag}`, `hidden-${tag}.png`, async (capture) => {
    await clear();
    await box.fill("/heap");
    assert.equal(await menu.count(), 0, "the agent's own menu hides /heapdump, so this one lists it nowhere");
    await box.fill("/heapdump");
    await send.click();
    await page.locator(".chat-turn-user").filter({ hasText: "/heapdump" }).first().waitFor();
    assert.deepEqual(await submits(), ["/config", "/heapdump"]);
    assert.equal(await actions.count(), 0);
    await capture();
  });
};
