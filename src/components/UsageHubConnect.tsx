import { useRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { CLIProxyStatus } from "../../shared/protocol.ts";
import { cliProxyRequest, fetchUsage } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";

export function UsageHubConnect({ hub, onConnected, onDone }: {
  readonly hub: CLIProxyStatus | null;
  readonly onConnected: (status: CLIProxyStatus) => void;
  readonly onDone: () => void;
}) {
  const t = useT();
  const { settings } = useSettings();
  const [url, setUrl] = useState(hub?.url ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyShown, setKeyShown] = useState(false);
  const [connected, setConnected] = useState<{ readonly count: number | null } | null>(null);
  const key = useRef<HTMLInputElement>(null);
  if (connected) return <div className="account-auth-form">
    <p className="settings-label" role="status">{connected.count === null ? t("Connected") : t("Connected · {count} accounts", { count: connected.count })}</p>
    <button className="btn" type="button" onClick={onDone}>{t("Done")}</button>
  </div>;
  return <form className="account-auth-form" onSubmit={(event) => {
    event.preventDefault();
    const secret = key.current?.value.trim() ?? "";
    if (key.current) key.current.value = "";
    setBusy(true); setError(null);
    void cliProxyRequest<CLIProxyStatus>("", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, ...(secret ? { management_key: secret } : {}) }),
    }).then(async (status) => {
      onConnected(status);
      if (!status.ok) { setError(status.problem ?? t("Check the hub connection")); return; }
      if (!settings.showUsage) { setConnected({ count: null }); return; }
      const report = await fetchUsage(true);
      setConnected({ count: report.providers.filter((usage) => usage.key.startsWith(`${usage.id}:cliproxy:`)).length });
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : t("Hub request failed")))
      .finally(() => setBusy(false));
  }}>
    <p className="settings-hint">{t("The key stays on this PC.")}</p>
    <label className="settings-label" htmlFor="usage-hub-url">{t("Hub URL")}</label>
    <input id="usage-hub-url" className="input" type="url" placeholder="http://localhost:8317" value={url} onChange={(event) => setUrl(event.target.value)} required disabled={busy} />
    <label className="settings-label" htmlFor="usage-hub-key">{t("Management key")}</label>
    <div className="usage-hub-key">
      <input ref={key} id="usage-hub-key" className="input" type={keyShown ? "text" : "password"} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={busy} placeholder={hub?.configured ? t("Blank keeps the saved key") : undefined} />
      <button type="button" className="icon-button" aria-pressed={keyShown} aria-controls="usage-hub-key" aria-label={t("Show key")} title={t("Show key")} onClick={() => setKeyShown(!keyShown)}>
        {keyShown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
      </button>
    </div>
    {error && <p className="settings-hint account-error" role="alert">{error}</p>}
    <button className="btn" type="submit" disabled={busy || !url}>{busy ? t("Connecting…") : t("Connect")}</button>
  </form>;
}
