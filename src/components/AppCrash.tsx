import { useEffect, useRef, useState, type Ref } from "react";
import { copyText } from "../lib/clipboard.ts";
import { crashProbe, type CrashRegion } from "../lib/crashProbe.ts";
import { t, useT } from "../lib/i18n.ts";
import "./AppCrash.css";

/** The error as text a bug report can carry: its message, its stack, where and on what it ran. */
export function crashDetails(error: unknown): string {
  const head = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const stack = error instanceof Error && error.stack ? error.stack : "";
  const trace = stack.startsWith(head) ? stack.slice(head.length).replace(/^\n/, "") : stack;
  return [head, trace, `Path: ${window.location.pathname}`, `User agent: ${navigator.userAgent}`].filter((line) => line !== "").join("\n");
}

/**
 * What the page shows when a render error reached the top of the tree (main.tsx). It sits
 * outside SettingsProvider, which may be what threw, so it reads the module-level `t` (the
 * language last set, English before any) and never a context. An installed web app has no
 * browser reload button, so Reload app is the way back.
 */
export function AppCrash({ error }: { error: unknown }) {
  const details = crashDetails(error);
  const detailsRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <main className="app-crash">
      <div className="app-crash-card error-state" role="alert">
        <h1 className="app-crash-title">{t("Something went wrong")}</h1>
        <p className="error-message">{t("The app hit an error and stopped drawing. Your terminals keep running in herdr.")}</p>
        <div className="app-crash-actions">
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>{t("Reload app")}</button>
          <button type="button" className="btn" onClick={() => void copyText(details, detailsRef.current).then(setCopied)}>{copied === true ? t("Copied") : t("Copy details")}</button>
        </div>
        {/* opened when copying was refused: copyText has selected the text for a long press or Ctrl+C */}
        <details className="app-crash-details" open={copied === false || undefined}>
          <summary>{t("Details")}</summary>
          <pre ref={detailsRef}>{details}</pre>
        </details>
      </div>
    </main>
  );
}

/**
 * A part of the app (Sidebar, a pane slot, Settings) that could not be drawn; the rest goes on.
 * `onShown` runs once it is drawn and again whenever the caller hands a new one, for what the part
 * that threw can no longer report itself (a pane slot's terminal its connection going).
 */
export function RegionCrash({ message, retry, retryLabel, buttonRef, onShown }: {
  message: string; retry: () => void; retryLabel?: string; buttonRef?: Ref<HTMLButtonElement>; onShown?: () => void;
}) {
  const t = useT();
  useEffect(() => { onShown?.(); }, [onShown]);
  return (
    <div className="error-state" role="alert">
      <p className="error-message">{message}</p>
      <button type="button" ref={buttonRef} className="btn" onClick={retry}>{retryLabel ?? t("Try again")}</button>
    </div>
  );
}

/** Renders nothing; in a build with test hooks it throws where the address says (lib/crashProbe.ts). */
export function CrashProbe({ region }: { region: CrashRegion }) {
  crashProbe(region);
  return null;
}
