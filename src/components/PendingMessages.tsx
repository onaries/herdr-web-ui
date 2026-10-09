import { useRef, useState } from "react";
import { ArrowUp, Copy, X } from "lucide-react";
import type { PendingMessageView } from "../lib/pendingMessages.ts";
import { copyText } from "../lib/clipboard.ts";
import { submitNote } from "../lib/compose.ts";
import { useT } from "../lib/i18n.ts";
import "./PendingMessages.css";

interface Props {
  messages: PendingMessageView[];
  connected: boolean;
  blocked: boolean;
  unsaved: boolean;
  isBusy: (id: string) => boolean;
  onSendNow: (id: string) => Promise<void>;
  onDiscard: (id: string) => Promise<void>;
}

/** Pending text is separate from the transcript; Send now acts on its ID, never on its text. */
export function PendingMessages({ messages, connected, blocked, unsaved, isBusy, onSendNow, onDiscard }: Props) {
  const t = useT();
  const rootRef = useRef<HTMLOListElement | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const restoreFocus = (keyboard: boolean, target: HTMLButtonElement, stack: Element | null, owner: string | null): void => {
    const root = rootRef.current;
    if (!keyboard || target.isConnected || !stack?.isConnected || stack.getAttribute("data-pane-owner") !== owner) return;
    const next = root?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?? stack.querySelector<HTMLTextAreaElement>(".composer-text");
    next?.focus({ preventScroll: true });
  };
  return <ol ref={rootRef} className="pending-messages" aria-label={t("Queued messages")}>
    {unsaved && <li className="pending-message-note" role="status">{t("Queue could not be saved. Keep this tab open or copy the messages before reloading.")}</li>}
    {messages.map((message) => {
      const busy = isBusy(message.id) || message.state === "sending";
      const uncertain = message.state === "uncertain";
      const status = busy ? t("Sending…") : message.state === "queued" ? t("Next turn") : uncertain ? t("Not confirmed. Check the terminal before sending again.") : t("Held message — review and send");
      return <li key={message.id} className="pending-message" data-state={message.state}>
        <div className="pending-message-bubble" aria-busy={busy || undefined}>{message.text}</div>
        <div className="pending-message-meta">
          <span className="pending-message-note" role="status">{status}</span>
          {!uncertain && <button type="button" className="icon-button pending-message-action pending-message-send"
            aria-label={`${t("Send now")}: ${message.text}`} aria-busy={busy || undefined} title={t("Send now")}
            disabled={!connected || blocked || busy} onClick={(event) => {
              const target = event.currentTarget, keyboard = event.detail === 0, stack = target.closest(".terminal-stack"), owner = stack?.getAttribute("data-pane-owner") ?? null;
              void onSendNow(message.id).finally(() => restoreFocus(keyboard, target, stack, owner));
            }}><ArrowUp aria-hidden="true" /><span>{t("Send now")}</span></button>}
          {uncertain && <button type="button" className="icon-button pending-message-action" aria-label={copied === message.id ? t("Copied") : t("Copy message")}
            title={t("Copy message")} onClick={(event) => {
              const text = event.currentTarget.closest(".pending-message")?.querySelector<HTMLElement>(".pending-message-bubble");
              void copyText(message.text, text).then((ok) => { if (ok) setCopied(message.id); });
            }}><Copy aria-hidden="true" /></button>}
          <button type="button" className="icon-button pending-message-action" aria-label={uncertain ? t("Discard saved copy") : t("Discard")}
            title={uncertain ? t("Discard saved copy") : t("Discard")} disabled={busy || message.serverOwned && !connected}
            onClick={(event) => {
              const target = event.currentTarget, keyboard = event.detail === 0, stack = target.closest(".terminal-stack"), owner = stack?.getAttribute("data-pane-owner") ?? null;
              void onDiscard(message.id).finally(() => restoreFocus(keyboard, target, stack, owner));
            }}><X aria-hidden="true" /></button>
        </div>
        {message.error && !uncertain && <p className="pending-message-note" role="status">{message.error.code === "input_draft" ? submitNote(message.error.code, message.error.message) : t("Not sent: {message}", { message: message.error.message })}</p>}
      </li>;
    })}
  </ol>;
}
