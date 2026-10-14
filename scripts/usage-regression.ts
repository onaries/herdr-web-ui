/** The plan meters beside Settings, on a staged report: no real sign-in is read or sent. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext } from "playwright-core";
import type { UsageReport } from "../shared/protocol.ts";
import { openSettingsPage } from "./settings-page.ts";

const at = (hours: number): string => new Date(Date.now() + hours * 3600_000).toISOString();
/** Built when it is asked for: its times hold however late in the run that is. */
const report = (): UsageReport => ({
  providers: [
    { id: "claude", key: "claude:u1", account: "me@example.com", plan: "max", problem: null, checked_at: at(0), windows: [
      // 2.8 hours into the session at 15%/h: lasts to the reset
      { kind: "session", scope: null, used_percent: 42, resets_at: at(2.2), starts_at: at(2.2 - 5) },
      // 86 hours into the week: runs out in about 2 days, 1.4 days before the reset
      { kind: "week", scope: null, used_percent: 63.4, resets_at: at(82), starts_at: at(82 - 168) },
      { kind: "week", scope: "Sonnet", used_percent: 5, resets_at: null, starts_at: null },
    ] },
    { id: "codex", key: "codex:work", account: "me@work.example", plan: "pro", problem: null, checked_at: at(0), windows: [
      { kind: "session", scope: null, used_percent: 12, resets_at: at(0.8), starts_at: at(0.8 - 5) },
      { kind: "week", scope: null, used_percent: 91, resets_at: at(99), starts_at: at(99 - 168) },
    ] },
    { id: "codex", key: "codex:home", account: "me@example.com", plan: "plus", problem: null, checked_at: "2026-09-29T12:00:00Z", windows: [
      { kind: "week", scope: null, used_percent: 30, resets_at: at(120), starts_at: null },
    ] },
    { id: "cursor", key: "cursor:c1", account: null, plan: "pro", problem: null, checked_at: "2026-09-29T12:00:00Z", windows: [{ kind: "month", scope: null, used_percent: 20, resets_at: at(300), starts_at: null }] },
    { id: "copilot", key: "copilot:me", account: "me", plan: "free", problem: null, checked_at: "2026-09-29T12:00:00Z", windows: [{ kind: "month", scope: "Chat", used_percent: 0, resets_at: at(34), starts_at: null }] },
    { id: "grok", key: "grok:g1", account: null, plan: null, problem: "rate_limited", checked_at: "2026-09-29T11:40:00Z", windows: [{ kind: "week", scope: null, used_percent: 0, resets_at: null, starts_at: null }] },
    { id: "antigravity", key: "antigravity@keychain", account: null, plan: null, problem: "expired", checked_at: null, windows: [] },
  ],
});

/** a header the check puts on every request of the page it reloads: what that page asked for, whenever it is counted */
const RELOADED = "x-usage-qa-reloaded";

async function staged(context: BrowserContext): Promise<{ asked: string[]; afterReload: string[] }> {
  const asked: string[] = [];
  const afterReload: string[] = [];
  await context.route("**/api/usage*", (route) => {
    asked.push(new URL(route.request().url()).search);
    if (route.request().headers()[RELOADED]) afterReload.push(route.request().url());
    return route.fulfill({ json: report() });
  });
  return { asked, afterReload };
}

export async function checkUsageMeters(browser: Browser, origin: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    const { asked, afterReload } = await staged(context);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    const strip = page.locator(".usage-strip");
    const settingsButton = page.locator(".sidebar-footer-row .sidebar-footer-action");
    const toggle = page.getByRole("switch", { name: "Show plan limits", exact: true });

    // off until chosen: nothing is shown and no sign-in is sent anywhere
    await settingsButton.waitFor();
    assert.equal(await strip.count(), 0);
    assert.deepEqual(asked, [], "no usage request before the user turns it on");
    await settingsButton.click();
    await openSettingsPage(page, "Subscription usage");
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    await toggle.click();
    await page.keyboard.press("Escape");
    await strip.waitFor();

    // three chips and "+4" past four accounts, in the server's order, each its plan's week; one near its limit is red; two Codex accounts apart
    assert.equal(await page.locator(".usage-chip").count(), 3);
    assert.equal(await page.locator(".usage-more").textContent(), "+4");
    assert.match(await strip.getAttribute("aria-label") ?? "",
      /^Subscription usage: Claude · me@example\.com 63%, Codex · me@work\.example 91%, Codex · me@example\.com 30%, Cursor 20%, Copilot · me 0%, Grok 0%, Antigravity —$/);
    assert.equal(await page.locator(".usage-chip").nth(1).evaluate((chip) => chip.classList.contains("is-high")), true);
    assert.equal(await strip.evaluate((el) => el.scrollWidth <= el.clientWidth), true, "the chips fit beside Settings");
    const [settings, meters] = await Promise.all([page.locator(".sidebar-footer-row .sidebar-footer-action").boundingBox(), strip.boundingBox()]);
    assert.ok(settings && meters && settings.x + settings.width <= meters.x, "Settings and the meters do not overlap");

    await strip.click();
    const popover = page.getByRole("dialog", { name: "Subscription usage", exact: true });
    await popover.waitFor();
    assert.equal(await popover.locator(".usage-provider").count(), 7);
    assert.equal(await popover.getByRole("meter").count(), 9);
    assert.equal(await popover.locator(".usage-account").first().textContent(), "me@example.com");
    assert.equal(await popover.locator(".usage-row.is-high").count(), 1);
    assert.equal(await popover.locator(".usage-note.is-problem").count(), 1, "only the expired sign-in reads as an error");
    if (process.env.UI_EVIDENCE_DIR) {
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await page.locator(".sidebar-shell").screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-popover.png") });
    }
    const refreshed = page.waitForRequest((request) => request.url().endsWith("/api/usage?refresh=1"));
    await popover.getByRole("button", { name: "Refresh", exact: true }).click();
    await refreshed;
    await page.keyboard.press("Escape");
    await popover.waitFor({ state: "hidden" });
    assert.equal(await strip.evaluate((el) => el === document.activeElement), true, "Escape hands focus back to the strip");

    // Settings: what is left instead, an account hidden from the strip, another moved up
    const names = () => page.locator(".usage-popover .usage-provider").evaluateAll((sections) => sections.map((section) => section.getAttribute("aria-label")));
    await settingsButton.click();
    await openSettingsPage(page, "Subscription usage");
    await page.getByRole("button", { name: "Remaining", exact: true }).click();
    await page.getByRole("switch", { name: "Show Codex · me@work.example", exact: true }).click();
    await page.getByRole("button", { name: "Move Cursor up", exact: true }).click();
    await page.keyboard.press("Escape");
    assert.equal(await strip.getAttribute("aria-label"),
      "Subscription usage: Claude · me@example.com 37% left, Cursor 80% left, Codex · me@example.com 70% left, Copilot · me 100% left, Grok 100% left, Antigravity —");
    assert.deepEqual(await page.locator(".usage-chip-value").allTextContents(), ["37%", "80%", "70%"]);
    await strip.click();
    assert.deepEqual((await names()).slice(0, 3), ["Claude · me@example.com", "Cursor", "Codex · me@example.com"], "a hidden account is left out of the popover too");
    assert.equal(await popover.locator(".usage-provider").count(), 6);
    assert.equal(await popover.locator(".usage-row-value").first().textContent(), "58% left");
    if (process.env.UI_EVIDENCE_DIR) await page.locator(".sidebar-shell").screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-popover-left.png") });
    await page.keyboard.press("Escape");
    await settingsButton.click();
    await openSettingsPage(page, "Subscription usage");
    if (process.env.UI_EVIDENCE_DIR) {
      await page.getByRole("tabpanel", { name: "Subscription usage", exact: true }).screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-settings.png") });
    }
    // the session instead of the week: an account without one keeps the limit it has
    await page.locator('.segmented[aria-label="Limit shown"]').getByRole("button", { name: "Session", exact: true }).click();
    await page.keyboard.press("Escape");
    assert.match(await strip.getAttribute("aria-label") ?? "", /^Subscription usage: Claude · me@example.com 58% left, Cursor 80% left, Codex · me@example.com 70% left,/);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:settings") ?? "{}") as { usageHidden?: string[]; usageCount?: string; usageGlance?: string });
    assert.deepEqual([stored.usageHidden, stored.usageCount, stored.usageGlance], [["codex:work"], "left", "session"]);

    // turned off in Settings: gone, and no longer asked for
    await settingsButton.click();
    await openSettingsPage(page, "Subscription usage");
    await toggle.click();
    await strip.waitFor({ state: "detached" });
    // a request Settings made before the switch can still be on its way here, so the count is of
    // the reloaded page's own requests, not of what arrives after the reload
    await context.setExtraHTTPHeaders({ [RELOADED]: "1" });
    await page.reload();
    await page.locator(".sidebar-footer").waitFor();
    assert.deepEqual(afterReload, [], "a hidden strip asks for nothing");
    await context.setExtraHTTPHeaders({});
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }

  // on a phone the popover opens inside the drawer and stays on screen
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: "en-US" });
  try {
    await staged(phone);
    await phone.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ showUsage: true })));
    const page = await phone.newPage();
    await page.goto(origin);
    await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
    await page.locator(".usage-strip").click();
    const popover = page.getByRole("dialog", { name: "Subscription usage", exact: true });
    await popover.waitFor();
    const box = await popover.boundingBox();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 390, "the popover stays inside the phone's screen");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.UI_EVIDENCE_DIR) await page.locator(".sidebar-shell").screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-popover-phone.png") });

    // Settings on the phone: every account row fits its card, controls included
    await page.keyboard.press("Escape");
    await page.locator(".sidebar-footer-row .sidebar-footer-action").click();
    await openSettingsPage(page, "Subscription usage");
    const accounts = page.locator(".usage-accounts");
    await accounts.scrollIntoViewIfNeeded();
    assert.equal(await accounts.locator(".usage-accounts-row").count(), 7);
    assert.equal(await accounts.evaluate((card) => [...card.querySelectorAll(".usage-accounts-row")].every((row) => row.scrollWidth <= row.clientWidth)), true, "each account row fits the phone");
    if (process.env.UI_EVIDENCE_DIR) {
      await page.getByRole("tabpanel", { name: "Subscription usage", exact: true }).screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-settings-phone.png") });
    }
  } finally {
    await phone.close();
  }
  console.log("PASS plan meters beside Settings: accounts, order, hiding, used or left, overflow, popover, refresh, Escape, off switch and phone fit");
}
