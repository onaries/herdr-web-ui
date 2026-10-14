import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { translate } from "../lib/i18n.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { PendingMessages } from "./PendingMessages.tsx";

const render = (code: string, message: string, languages: string[]): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: languages });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(PendingMessages, {
      messages: [{ id: "p1", request_id: 1, text: "ls", state: "held", created_at: "2026-10-14T00:00:00.000Z", serverOwned: true, error: { code, message } }],
      connected: true, blocked: false, unsaved: false, isBusy: () => false,
      onSendNow: async () => {}, onDiscard: async () => {},
    }) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

describe("a pending row's refusal note", () => {
  it("says a held-input refusal in the reader's language, not the raw English reason", () => {
    const held = translate("ko", "Not sent: send or discard the held input first.");
    expect(held).not.toBe("Not sent: send or discard the held input first.");
    const html = render("held_input", "send or discard the held input first", ["ko"]);
    expect(html).toContain(held);
    expect(html).not.toContain("send or discard the held input first");
  });

  it("keeps the server's reason for other refusals", () => {
    expect(render("agent_blocked", "the agent is busy", ["en"])).toContain("Not sent: the agent is busy");
  });
});
