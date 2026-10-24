import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { HerdrPane } from "../../shared/protocol.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { PaneLenses } from "./paneLens.ts";
import type { PaneView } from "./actions.ts";
import { notificationViewForPane, type NotificationTarget } from "./notificationTarget.ts";
import type { TerminalPeek } from "./terminalPeek.ts";
import type { Settings } from "./settings.ts";

/**
 * The lens a pane opens in: the one picked for it by hand, remembered per pane, else its default
 * (lib/paneLens.ts), kept for the page once the pane is known so an agent starting or exiting in
 * it does not switch the lens under the user. A PC whose herdr has no terminal attach and no
 * mirror either (an older Windows bridge) always opens its chat: its terminal lens is only a
 * notice, so a remembered choice there is not worth keeping. A mirrored PC counts as having a
 * terminal.
 */
/** `hasAgent`: herdr leaves `agent` out for a shell, so callers compare with `!= null` */
export function storedView(lenses: PaneLenses, picks: ReadonlyMap<string, PaneView>, paneId: string, machineId: string, hasAgent: boolean | null, terminalAttach: boolean): PaneView {
  if (!terminalAttach) return "chat";
  const key = paneStorageId(machineId, paneId);
  const picked = picks.get(key);
  if (picked !== undefined) return picked;
  try {
    const stored = window.localStorage.getItem(`ovis:view:${key}`);
    if (stored === "chat" || stored === "terminal") return stored;
  } catch {
    /* private mode */
  }
  return lenses.of(key, hasAgent, window.matchMedia?.("(pointer: coarse)").matches === true);
}

export function usePaneLensState() {
  const [lens, setLens] = useState<{ key: string; view: PaneView }>({ key: "", view: "terminal" });
  // Explicit lens choices stay authoritative in this page even when storage cannot be written.
  const [viewPicks, setViewPicks] = useState<ReadonlyMap<string, PaneView>>(() => new Map());
  return { lens, setLens, viewPicks, setViewPicks };
}

export function usePaneLens({ settings, selectedPaneId, selectedMachineId, selectedPane, selectedAgent, terminalAttach, notificationViewTarget, lens, setLens, viewPicks, terminalPeek, setTerminalPeek }: {
  settings: Settings;
  selectedPaneId: string | null;
  selectedMachineId: string;
  selectedPane: HerdrPane | null;
  selectedAgent: HerdrPane["agent"] | null;
  terminalAttach: boolean;
  notificationViewTarget: NotificationTarget | null;
  lens: { key: string; view: PaneView };
  setLens: Dispatch<SetStateAction<{ key: string; view: PaneView }>>;
  viewPicks: ReadonlyMap<string, PaneView>;
  terminalPeek: TerminalPeek | null;
  setTerminalPeek: Dispatch<SetStateAction<TerminalPeek | null>>;
}) {
  // the lens follows the selected pane: each pane remembers its own. It is settled in the render
  // that selects the pane, not in an effect after it: the pane's terminal attaches in that render's
  // layout effect, and an attach in the previous pane's lens resized a pane whose lens is chat
  // a new Settings default is a new start for every pane's lens
  const lenses = useMemo(() => new PaneLenses(settings.defaultView), [settings.defaultView]);
  const lensKey = JSON.stringify([selectedPaneId, selectedMachineId, selectedPane !== null, selectedAgent !== null, terminalAttach, settings.defaultView]);
  const notificationView = notificationViewForPane(notificationViewTarget, selectedMachineId, selectedPaneId);
  let view = lens.view;
  if (lens.key !== lensKey) {
    if (selectedPaneId !== null) view = storedView(lenses, viewPicks, selectedPaneId, selectedMachineId, selectedPane ? selectedAgent !== null : null, terminalAttach);
    setLens({ key: lensKey, view });
    // another pane, PC or lens default: the peek was the previous pane's
    if (terminalPeek !== null) setTerminalPeek(null);
  }
  // a tapped alert's lens is drawn over the pane's own, never stored: once it is gone (the pane or
  // its lens picked by hand) the pane is back on the lens it had. A shell has no conversation to
  // show (storedView), so its alert opens its own lens; until the snapshot says, it counts as an agent
  if (notificationView !== null && !(notificationView === "chat" && selectedPane !== null && selectedAgent === null)) view = notificationView;
  return { lenses, view };
}

export function usePaneViewPicks({ setViewPicks, setNotificationViewTarget, setTerminalPeek, setLens, setAutoSelected, selectedPaneId, selectedMachineId }: {
  setViewPicks: Dispatch<SetStateAction<ReadonlyMap<string, PaneView>>>;
  setNotificationViewTarget: Dispatch<SetStateAction<NotificationTarget | null>>;
  setTerminalPeek: Dispatch<SetStateAction<TerminalPeek | null>>;
  setLens: Dispatch<SetStateAction<{ key: string; view: PaneView }>>;
  setAutoSelected: Dispatch<SetStateAction<boolean>>;
  selectedPaneId: string | null;
  selectedMachineId: string;
}) {
  const pickView = useCallback((machineId: string, paneId: string, next: PaneView) => {
    const key = paneStorageId(machineId, paneId);
    setViewPicks((current) => current.get(key) === next ? current : new Map(current).set(key, next));
    try {
      window.localStorage.setItem(`ovis:view:${key}`, next);
    } catch {
      /* private mode: the lens is still picked for this page */
    }
  }, []);

  const setView = useCallback(
    (next: PaneView) => {
      setNotificationViewTarget(null); setTerminalPeek(null);
      setLens((current) => ({ ...current, view: next }));
      setAutoSelected(false);
      if (selectedPaneId === null) return;
      pickView(selectedMachineId, selectedPaneId, next);
    },
    [selectedPaneId, selectedMachineId, pickView],
  );
  return { pickView, setView };
}
