import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { CommandOutcome } from "../../shared/protocol.ts";
import type { TranscriptMessage } from "../lib/transcript.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { ChatFallback } from "./ChatView.tsx";

const outcome = (over: Partial<CommandOutcome> & { id: string; text: string }): CommandOutcome => ({
  pane_id: "w1:p1", state: "accepted", evidence: [], created_at: "2026-10-20T10:00:00.000Z", updated_at: "2026-10-20T10:00:00.000Z", ...over,
});

const render = (props: { agent: string | null; messages: TranscriptMessage[]; outcomes: CommandOutcome[]; restored?: string | null }): string => {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(ChatFallback, {
      paneId: "w1:p1", visible: true, actions: null, skills: null, restored: null, ...props,
    }) }));
  } finally {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

describe("the chat's fallback transcript", () => {
  it("draws a tracked command the terminal-output fallback has no turn for as a sent row with its chip", () => {
    const btw = outcome({ id: "o-btw", text: "/btw is this safe?", state: "terminal-required", preview: "❯ /btw is this safe?\nyes" });
    const html = render({ agent: "claude", messages: [], outcomes: [btw] });
    expect(html).toContain('data-outcome-id="o-btw"');
    expect(html).toContain('data-outcome-state="terminal-required"');
    expect(html).toContain("chat-turn-sent");
    expect(html).toContain("chat-outcome-preview");
    expect(html.match(/chat-turn-user/g)).toHaveLength(1);
  });

  it("puts the chip on the scrollback turn that records the command, and a sent row for one no turn records", () => {
    const messages: TranscriptMessage[] = [
      { role: "user", text: "/compact" },
      { role: "assistant", text: "Compacted." },
      { role: "status", text: "❯" },
    ] as TranscriptMessage[];
    const compact = outcome({ id: "o-compact", text: "/compact", state: "result-observed", evidence: [{ kind: "transcript", at: "2026-10-20T10:00:05.000Z" }] });
    const cost = outcome({ id: "o-cost", text: "/cost", state: "terminal-required", created_at: "2026-10-20T10:01:00.000Z", updated_at: "2026-10-20T10:01:00.000Z" });
    const html = render({ agent: null, messages, outcomes: [compact, cost] });
    expect(html).toContain('data-outcome-state="result-observed"');
    expect(html).toContain('data-outcome-id="o-cost"');
    expect(html.match(/chat-turn-sent/g)).toHaveLength(1);
    expect(html.match(/class="chat-outcome"/g)).toHaveLength(2);
    expect(html.match(/chat-turn-user/g)).toHaveLength(2);
  });

  it("gives a cancelled send the agent put back no row, and keeps the receipt of an earlier identical send", () => {
    const first = outcome({ id: "o-first", text: "/compact", state: "result-observed", evidence: [{ kind: "transcript", at: "2026-10-20T10:00:05.000Z" }] });
    const second = outcome({ id: "o-second", text: "/compact", created_at: "2026-10-20T10:02:00.000Z", updated_at: "2026-10-20T10:02:00.000Z" });
    const html = render({ agent: "claude", messages: [], outcomes: [first, second], restored: "/compact" });
    expect(html).toContain('data-outcome-id="o-first"');
    expect(html).not.toContain('data-outcome-id="o-second"');
  });
});
