import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { SUMMARY_GROUPS, type SummaryGroup, type UpdateNotes, type UpdateStatus } from "../../shared/update.ts";
import { useHerdrUpdate } from "../lib/herdrUpdate.ts";
import { runningAppVersion, runningHerdrVersion, staleClientVersion, versionLabel } from "../lib/runningVersion.ts";
import { useSettings } from "../lib/settings.ts";
import { announcesUpdate, readAnnounced, summaryFor, watchAnnounced, writeAnnounced } from "../lib/updateNotes.ts";
import { describeUpdate } from "../lib/updateProgress.ts";
import type { UpdatesModel } from "../lib/updates.ts";
import { lazyChunkFailed, onLazyChunkFailure } from "../lib/lazyChunk.ts";
import { Markdown } from "./Markdown.tsx";
import { RenderBoundary } from "./RenderBoundary.tsx";
import "./Machines.css";
import "./UpdateControls.css";
import { useLocale, useT } from "../lib/i18n.ts";

declare const __APP_VERSION__: string;

const CHANGELOG = "https://github.com/devswha/herdr-web-ui/blob/main/CHANGELOG.md";

/**
 * What an update brings, or brought: each release it installs, newest first. A release is told
 * as patch notes, short lines in the app's language under what is new, improved and fixed, with
 * its changelog section folded under them; a release that wrote none shows the section as the
 * release wrote it (English). The box scrolls on its own, so the buttons under it stay in reach. The text comes
 * from the Git remote: a section that cannot be drawn says so and takes nothing else down
 * with it.
 */
function ReleaseNotes({ notes, label }: { notes: Pick<UpdateNotes, "releases" | "omitted">; label: string }) {
  const t = useT();
  const { resolvedLanguage } = useSettings();
  // the lists of a release's highlights, as patch notes name them
  const groups: Record<SummaryGroup, string> = { new: t("New features"), improved: t("Improvements"), fixed: t("Bug fixes") };
  return <>
    <span className="settings-label">{label}</span>
    <div className="update-notes" role="region" aria-label={label} tabIndex={0}>
      {notes.releases.map((release) => {
        const summary = summaryFor(release, resolvedLanguage);
        const section = <RenderBoundary resetKey={release.notes} fallback={() => <p className="settings-hint">{t("These notes could not be shown.")} <a href={CHANGELOG} target="_blank" rel="noopener noreferrer">{t("Full changelog")}</a></p>}>
          <Markdown>{release.notes}</Markdown>
        </RenderBoundary>;
        return <section key={release.version}>
          <h4>v{release.version}{release.date && <time>{release.date}</time>}</h4>
          {summary === null ? section : <>
            <div className="update-summary">
              {SUMMARY_GROUPS.map((group) => summary[group] && <div key={group}>
                <h5>{groups[group]}</h5>
                <ul>{summary[group].map((line, index) => <li key={index}>{line}</li>)}</ul>
              </div>)}
            </div>
            <details className="update-details">
              <summary>{t("Show every change")}</summary>
              {section}
            </details>
          </>}
        </section>;
      })}
      {notes.omitted > 0 && <p className="settings-hint">{t("Earlier releases not shown here: {count}.", { count: notes.omitted })} <a href={CHANGELOG} target="_blank" rel="noopener noreferrer">{t("Full changelog")}</a></p>}
    </div>
  </>;
}

/**
 * An install as a step and a bar. A server that names no step (the one being replaced may be
 * older than the steps) gets the phase in words and a bar that only moves.
 */
function UpdateProgress({ status, fallback }: { status: UpdateStatus | null; fallback: string }) {
  const t = useT();
  const view = describeUpdate(status);
  const label = view ? t(view.label) : fallback;
  return <div className="bridge-progress update-progress">
    <p className="bridge-progress-step"><span>{label}</span>{view && <span className="bridge-progress-count">{view.step}</span>}</p>
    <div className="bridge-progress-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} {...(view ? { "aria-valuenow": view.percent } : {})}>
      <span className={view ? "" : "is-indeterminate"} style={view ? { width: `${view.percent}%` } : undefined} />
    </div>
  </div>;
}

export function UpdateControls({ updates, bridgesFollow = false }: { updates: UpdatesModel; bridgesFollow?: boolean }) {
  const t = useT();
  const { status, error, busy, needsReload, reload, notes, installed, request } = updates;
  const locale = useLocale();
  const installing = busy && (status?.phase === "building" || status?.phase === "restarting");
  const tabVersion = staleClientVersion(status, __APP_VERSION__);
  // focusable from code only: a button that points here (the header line's) lands on it
  return <section className="settings-section settings-updates" data-section="updates" tabIndex={-1} aria-labelledby="settings-updates-title">
    <h3 id="settings-updates-title">{t("Updates")}</h3>
    <div className="settings-card"><div className="settings-item">
    {/* always a version: the sidebar no longer carries one */}
    <p className="settings-hint">{t("Running {version}", { version: runningAppVersion(status, __APP_VERSION__) })}</p>
    {tabVersion && <p className="settings-hint">{t("This tab still runs {version} until it is reloaded.", { version: tabVersion })}</p>}
    {installing && !error ? <div role="status"><UpdateProgress status={status} fallback={t(status?.phase === "building" ? "Installing dependencies and building…" : "Restarting the bridge…")} /></div> : <p className="settings-hint" role="status">
      {error ?? status?.error ?? status?.blocked_reason ?? (busy ? t("Checking for updates…") :
        status?.available ? t("Version {version} is available.", { version: versionLabel(status.latest_version, status.latest_revision) ?? "" }) : status?.checked_at ? t("Up to date.") : t("Waiting for an update check…"))}
    </p>}
    {notes && <ReleaseNotes notes={notes} label={t("What's new")} />}
    {/* under the release on offer, when there is one: what runs now stays to be read */}
    {installed && installed.releases.length > 0 && <ReleaseNotes notes={installed} label={t("What the last update brought")} />}
    {status?.managed && <>
      <p className="settings-hint">{t("Checks for new releases every 5 minutes.")} {t(status.auto_update ? "Automatic installation is enabled." : "Install when you are ready; the bridge briefly reconnects and herdr sessions keep running.")}{bridgesFollow ? ` ${t("Remote PCs' bridges are updated afterwards when the new version needs it.")}` : ""}</p>
      <div className="update-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void request("check")}>{t("Check for updates")}</button>
        <button type="button" className="btn btn-primary" disabled={busy || !status.available || !!status.blocked_reason} onClick={() => void request("install")}>{t("Update and restart")}</button>
      </div>
    </>}
    {status?.checked_at && <p className="settings-hint">{t("Last checked {when}", { when: new Date(status.checked_at).toLocaleString(locale) })}</p>}
    {needsReload && <p className="settings-hint">{reload === "updated" ? t("The server was updated. Save any unsent drafts, then") : t("Part of the app could not load. Save unsent drafts, then reload.")} <button type="button" className="btn" onClick={() => window.location.reload()}>{t("Reload app")}</button></p>}
    </div></div>
  </section>;
}

/**
 * herdr itself. `herdr update` typed into a pane is refused by herdr, and every terminal here is
 * a pane: the server runs it instead and moves the running panes onto the new version.
 */
export function HerdrUpdateControls({ enabled, herdrVersion }: { enabled: boolean; herdrVersion: string | null }) {
  const t = useT();
  const { status, error, busy, request } = useHerdrUpdate(enabled);
  const version = runningHerdrVersion(status, herdrVersion);
  // Windows, an older server, a herdr that does not answer: nothing to offer, and the version
  // the health check reported is still read here, since the sidebar no longer carries it
  if (!status?.supported) {
    return version ? <section className="settings-section settings-herdr-update">
      <h3>herdr</h3>
      <div className="settings-card"><p className="settings-item settings-hint">{t("Running herdr {version}", { version })}</p></div>
    </section> : null;
  }
  const stale = status.stale && !!status.binary_version && !!status.server_version;
  return <section className="settings-section settings-herdr-update">
    <h3>herdr</h3>
    <div className="settings-card"><div className="settings-item">
    {version && <p className="settings-hint">{t("Running herdr {version}", { version })}</p>}
    {stale && <p className="settings-hint">{t("herdr {installed} is installed, but the running server is {running}. Updating moves your panes onto the installed version.", { installed: status.binary_version ?? "", running: status.server_version ?? "" })}</p>}
    <p className="settings-hint">{t("Installs the newest herdr on the PC this app runs on and moves its running panes onto it. Panes and agents keep running, and open terminals reconnect.")}</p>
    <div className="update-actions">
      <button type="button" className={stale ? "btn btn-primary" : "btn"} disabled={busy} onClick={() => void request()}>{t("Update herdr")}</button>
    </div>
    {(error || busy) && <p className="settings-hint" role="status">{error ?? t("Updating herdr…")}</p>}
    {/* herdr's own words: what it installed, or why it did not */}
    {!busy && status.output && <pre className="update-output" data-failed={status.phase === "error" || undefined}>{status.output}</pre>}
    </div></div>
  </section>;
}

/**
 * The app-wide line for a release: one button installs it from here, and the line follows the
 * install to the reload, then tells of the update once the new version runs. It stays one line
 * on any width; Settings is where its notes and a failure are read in full.
 */
export function UpdateNotice({ updates, onOpen }: { updates: UpdatesModel; onOpen: () => void }) {
  const t = useT();
  const { status, error, busy, needsReload, reload, notes, installed, request } = updates;
  // the version whose line this device closed: opening its notes closes it too, in every tab
  const [announced, setAnnounced] = useState(readAnnounced);
  // subscribed first, then read: a dismissal in another tab between this tab's first read and its subscription is not lost
  useEffect(() => { const stop = watchAnnounced(setAnnounced); setAnnounced(readAnnounced()); return stop; }, []);
  // the check an install starts with reports nothing available until it is done: the line this
  // button sits on must not leave between the tap and the first step
  const [started, setStarted] = useState(false);
  useEffect(() => { if (!busy) setStarted(false); }, [busy]);
  const failed = error !== null || (status?.phase === "error" && !!status.error);
  // that same check can be what fails, and then nothing is available either: the line stays for
  // the install asked for here. A background check that fails alone is Settings' to report.
  const [attempted, setAttempted] = useState(false);
  useEffect(() => { if (!busy && !failed) setAttempted(false); }, [busy, failed]);
  const installing = status?.phase === "building" || status?.phase === "restarting";
  // Try again after such a failure looks for the release again, and the line waits with it
  const looking = attempted && busy;
  if (!needsReload && !status?.available && !installing && !started && !looking && !(attempted && failed)) {
    if (!installed?.version || !announcesUpdate(status, installed, announced, Date.now())) return null;
    const version = installed.version;
    const close = () => { writeAnnounced(version); setAnnounced(version); };
    const text = t("herdr web ui was updated to v{version}.", { version });
    return <div className="update-notice is-line" role="status">
      <span title={text}>{text}</span>
      {installed.releases.length > 0 && <button type="button" className="btn btn-ghost" onClick={() => { close(); onOpen(); }}>{t("What's new")}</button>}
      <button type="button" className="icon-button update-notice-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={close}><X /></button>
    </div>;
  }
  if (installing || started || looking) {
    return <div className="update-notice is-line is-progress" role="status">
      <UpdateProgress status={status} fallback={t(installing ? status?.phase === "building" ? "Installing dependencies and building…" : "Restarting the bridge…" : started ? "Starting the update…" : "Checking for updates…")} />
    </div>;
  }
  if (needsReload) {
    // a warning before a step that loses unsent drafts: read in full, so this line alone may wrap
    const text = reload === "updated" ? t("App updated. Save unsent drafts before reloading.") : t("Part of the app could not load. Save unsent drafts, then reload.");
    return <div className="update-notice is-line is-warning" role="status">
      <span>{text}</span>
      <button type="button" className="btn" onClick={() => window.location.reload()}>{t("Reload app")}</button>
    </div>;
  }
  // without a release in reach the server refuses an install: ask it to look again first
  const retry = status?.available ? "install" : "check";
  const text = failed ? t("The update could not be installed.") : status?.latest_version ? t("herdr web ui v{version} is available.", { version: status.latest_version }) : t("A herdr web ui update is available.");
  return <div className="update-notice is-line" role="status">
    <span title={text}>{text}</span>
    {failed ? <button type="button" className="btn btn-ghost" onClick={onOpen}>{t("Details")}</button>
      : notes && <button type="button" className="btn btn-ghost" onClick={onOpen}>{t("What's new")}</button>}
    <button type="button" className="btn btn-primary" disabled={busy} onClick={() => { setAttempted(true); setStarted(retry === "install"); void request(retry); }}>{t(failed ? "Try again" : "Update")}</button>
  </div>;
}

/**
 * The reload line alone, for a page without the update model: the markdown reader tab
 * (FileReader). A part of the app that failed to load there (lib/lazyChunk.ts) leaves math as its
 * source or a diagram as code until a reload, which this line offers. No status is polled.
 */
export function ChunkFailureNotice() {
  const t = useT();
  const [failed, setFailed] = useState(lazyChunkFailed);
  // subscribed first, then read: a failure between the first render and the subscription is kept
  useEffect(() => { const stop = onLazyChunkFailure(() => setFailed(true)); setFailed(lazyChunkFailed()); return stop; }, []);
  if (!failed) return null;
  return <div className="update-notice is-line is-warning" role="status">
    <span>{t("Part of the app could not load. Save unsent drafts, then reload.")}</span>
    <button type="button" className="btn" onClick={() => window.location.reload()}>{t("Reload app")}</button>
  </div>;
}
