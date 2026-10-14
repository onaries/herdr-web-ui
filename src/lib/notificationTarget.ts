import type { AppLink } from "./deepLink.ts";

export type NotificationPaneView = "chat" | "terminal";
/** `workspace_id`: the workspace the pane was last seen in (server/push.ts), so an ended pane's tap opens it. */
export type NotificationTarget = { machine_id: string; pane_id: string; view?: NotificationPaneView; workspace_id?: string };
type Target = NotificationTarget;
type Select = (target: Target) => void;

export function notificationTargetFromSearch(search: string): NotificationTarget | null {
  const params = new URLSearchParams(search);
  const pane_id = params.get("pane");
  const view = params.get("view");
  if (!pane_id || (view !== "chat" && view !== "terminal")) return null;
  return { machine_id: params.get("machine") ?? "local", pane_id, view };
}

export function notificationViewForPane(target: NotificationTarget | null, machineId: string, paneId: string | null): NotificationPaneView | null {
  if (!target || paneId === null || target.machine_id !== machineId || target.pane_id !== paneId) return null;
  return target.view ?? null;
}
/** The roster is in and does not list this PC: it was removed since (the roster lists every PC set up, connected or not). */
export function machineMissing(roster: readonly { id: string }[], machineId: string): boolean {
  return roster.length > 0 && !roster.some((machine) => machine.id === machineId);
}

/**
 * Whether a PC named at roster `since` (the count of rosters the server had sent then) is gone:
 * only a roster the server sent after that can say so. The list in hand when a link or a
 * selection was made may predate the PC (a tab resumed before its roster refreshed, a PC just
 * added), and a list rebuilt from it (a pane's status) is no newer. `since` null: nothing waits.
 */
export function machineGone(roster: readonly { id: string }[], rosterSeq: number, since: number | null, machineId: string): boolean {
  return since !== null && rosterSeq > since && machineMissing(roster, machineId);
}

type RosterMachine = { id: string; snapshot?: { panes: readonly { pane_id: string }[] } | null };

/**
 * Where a tapped notification lands. A pane the roster lists: selected at once. Anything else
 * waits as a link to that pane (and the workspace it was last seen in) does, settled against the
 * PC's roster with the same notes (lib/deepLink.ts resolveLink). A PC the roster in hand does not
 * list is `stale`: only a roster asked for now says whether it is gone (machineGone).
 */
export function notificationLanding(roster: readonly RosterMachine[], target: NotificationTarget): { kind: "select" } | { kind: "link"; link: AppLink; stale: boolean } {
  const machine = roster.find((candidate) => candidate.id === target.machine_id);
  if (machine?.snapshot?.panes.some((pane) => pane.pane_id === target.pane_id)) return { kind: "select" };
  const link: AppLink = { machine: target.machine_id, workspace: target.workspace_id ?? null, pane: target.pane_id, view: target.view ?? null, settings: null };
  return { kind: "link", link, stale: machineMissing(roster, target.machine_id) };
}

/** The same place: a second delivery of one tap (public/sw.js names it before and after focus). */
export function sameLink(a: AppLink | null, b: AppLink): boolean {
  return a !== null && a.machine === b.machine && a.pane === b.pane && (a.workspace ?? null) === (b.workspace ?? null) && (a.view ?? null) === (b.view ?? null);
}

type MessageSource = { addEventListener: (type: "message", listener: (event: MessageEvent) => void) => void };

/** Keep the newest target until App is ready, then deliver new selections directly. */
export function notificationTargets(source?: MessageSource): (select: Select) => () => void {
  let pending: Target | null = null;
  let consumer: Select | null = null;
  source?.addEventListener("message", (event) => {
    const data = event.data as { type?: unknown; pane_id?: unknown; machine_id?: unknown; view?: unknown; workspace_id?: unknown } | null;
    if (data?.type !== "select-pane" || typeof data.pane_id !== "string") return;
    const target: Target = {
      machine_id: typeof data.machine_id === "string" ? data.machine_id : "local",
      pane_id: data.pane_id,
    };
    if (data.view === "chat" || data.view === "terminal") target.view = data.view;
    if (typeof data.workspace_id === "string" && data.workspace_id !== "") target.workspace_id = data.workspace_id;
    if (consumer) consumer(target);
    else pending = target;
  });
  return (select) => {
    consumer = select;
    const target = pending;
    pending = null;
    if (target) select(target);
    return () => { if (consumer === select) consumer = null; };
  };
}

// Browser messages can arrive after document loading but before React's effect.
// Install this listener while App's module loads, before creating its root.
export const onNotificationTarget = notificationTargets(
  typeof navigator !== "undefined" && "serviceWorker" in navigator ? navigator.serviceWorker : undefined,
);
