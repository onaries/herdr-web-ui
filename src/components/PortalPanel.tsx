import { useState } from "react";

import "./PortalPanel.css";
import "./UpdateControls.css";

import { useT } from "../lib/i18n.ts";
import { usePortal } from "../lib/portal.ts";
import { Address } from "./PhonePanel.tsx";
import { SettingsGroup, SettingsRow } from "./SettingsControls.tsx";

const PORTAL_INSTALL = "https://github.com/gosuda/portal-tunnel#quick-start";

/**
 * Settings → Phone & devices → Portal: a public HTTPS address for this PC through a relay the
 * user picks, run by the `portal` installed there. Any device that can type starts and stops it;
 * the server refuses without a token. Hidden where the server offers none.
 */
export function PortalPanel({ readOnly = false }: { readOnly?: boolean }) {
  const t = useT();
  const { status, error, pending, busy, request } = usePortal();
  // what was typed; until then, the relay this PC used last
  const [typed, setTyped] = useState<string | null>(null);
  if (!status?.supported) return null;
  const relay = typed ?? status.relay ?? "";
  const on = status.phase !== "idle";
  // a Portal that ended on its own is started again once by the server; Stop still ends it
  const progress = status.phase === "starting" ? t("Starting…") : status.phase === "recovering" ? t("Recovering…") : status.phase === "stopping" ? t("Stopping…") : null;
  let control;
  if (on) {
    control = (
      <SettingsRow label={t("Relay")} description={status.relay ?? undefined}>
        <button type="button" className="btn" disabled={readOnly || pending || status.phase === "stopping"} onClick={() => void request("stop")}>{t("Stop")}</button>
      </SettingsRow>
    );
  } else if (status.blocked !== null) {
    control = <p className="settings-item settings-hint">{status.blocked === "token_required" ? t("Set OVIS_TOKEN on this PC and restart the app to start Portal.") : t("Portal is a second way in: unset OVIS_TAILSCALE_SERVE_ONLY on this PC and restart the app first.")}</p>;
  } else if (!status.usable) {
    control = (
      <div className="settings-item">
        <p className="settings-hint">
          {status.version === null ? t("Portal is not installed on this PC.") : t("This PC has Portal {version}; the app needs {min} or later.", { version: status.version, min: status.min_version })}{" "}
          <a className="settings-link" href={PORTAL_INSTALL} target="_blank" rel="noreferrer">{t("Get Portal")}</a>
        </p>
      </div>
    );
  } else {
    control = (
      <SettingsRow label={t("Relay")} htmlFor="portal-relay" description={t("A relay you trust, from portal list: it holds the address's certificate, so one set up to intercept could read the traffic.")} wide>
        <form className="portal-start" onSubmit={(event) => { event.preventDefault(); void request("start", relay); }}>
          <input id="portal-relay" className="input" inputMode="url" value={relay} placeholder="https://relay.example.com" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={readOnly || busy} onChange={(event) => setTyped(event.currentTarget.value)} />
          <button type="submit" className="btn btn-primary" disabled={readOnly || busy || relay.trim() === ""}>{t("Start")}</button>
        </form>
      </SettingsRow>
    );
  }
  return (
    <SettingsGroup title="Portal" note={t("A public HTTPS address for this PC through a Portal relay. Anyone on the internet can open it, so it needs an access token.")}>
      {status.url !== null && (
        <div className="settings-item phone-panel">
          <Address url={status.url} title={t("Portal serves this PC")} />
          <p className="settings-description">{t("Open it on your phone and sign in with the access token, or pair the phone: Devices, below.")}</p>
        </div>
      )}
      {control}
      {progress !== null && <p className="settings-item settings-hint portal-progress" role="status">{progress}</p>}
      {error !== null && <p className="settings-item settings-hint portal-error" role="alert">{error}</p>}
      {/* the server's account of the last failure, then Portal's own words */}
      {status.phase === "error" && status.error !== null && (
        <div className="settings-item">
          <p className="settings-hint portal-error" role="alert">{status.error}</p>
          {status.output !== null && (
            <details>
              <summary>{t("Portal's output")}</summary>
              <pre className="update-output" data-failed>{status.output}</pre>
            </details>
          )}
        </div>
      )}
    </SettingsGroup>
  );
}
