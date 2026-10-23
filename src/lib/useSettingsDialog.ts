import { useCallback, useEffect, useRef, useState } from "react";
import type { AppLink } from "./deepLink.ts";
import { onSettingsHistory, recordSettings } from "./settingsHistory.ts";

/** Keeps the Settings dialog navigation state. */
export function useSettingsDialog(initialLink: AppLink | null) {
  // a link to Settings opens it on its page, for that first opening alone
  const [settingsOpen, setSettingsOpen] = useState(() => initialLink?.settings != null);
  const [settingsLinkPage, setSettingsLinkPage] = useState<string | null>(() => initialLink?.settings ?? null);
  // the group on that page a link named: in the address while that page is shown
  const [settingsLinkSection, setSettingsLinkSection] = useState<string | null>(() => initialLink?.section ?? null);
  // the page Settings shows, for the address
  const [settingsPage, setSettingsPage] = useState<string | null>(null);
  // set by a button that points at one section of Settings, for that opening alone
  const [settingsSection, setSettingsSection] = useState<"updates" | null>(null);
  const closeSettings = useCallback(() => { setSettingsOpen(false); setSettingsSection(null); setSettingsLinkPage(null); setSettingsLinkSection(null); setSettingsPage(null); }, []);
  const settingsLinkPageRef = useRef(settingsLinkPage); settingsLinkPageRef.current = settingsLinkPage;
  const onSettingsPage = useCallback((page: string | null) => {
    setSettingsPage(page);
    if (page !== settingsLinkPageRef.current) setSettingsLinkSection(null);
  }, []);
  // Settings is in the history (lib/settingsHistory.ts): Back out of its last entry closes it,
  // Forward onto one opens it again, and closing it any other way takes its entries off
  useEffect(() => onSettingsHistory((entry, own) => {
    if (own) return;
    if (entry === null) closeSettings();
    else setSettingsOpen(true);
  }), [closeSettings]);
  useEffect(() => { if (!settingsOpen) recordSettings([]); }, [settingsOpen]);

  return {
    settingsOpen,
    setSettingsOpen,
    settingsLinkPage,
    setSettingsLinkPage,
    settingsLinkSection,
    setSettingsLinkSection,
    settingsPage,
    setSettingsPage,
    settingsSection,
    setSettingsSection,
    closeSettings,
    onSettingsPage,
  };
}
