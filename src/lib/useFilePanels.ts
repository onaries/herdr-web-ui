import { useCallback, useEffect, useRef, useState } from "react";

import { LOCAL_MACHINE } from "../../shared/machines.ts";
import { openPresentation, type FilePresentation } from "./filePresentation.ts";
import { useFocusReturn } from "./useFocusTrap.ts";
import { useFileViewer } from "./useFileViewer.ts";
import { useRepoDiffViewer } from "./useRepoDiffViewer.ts";
import { panelUrl, wantsPanel } from "./webPanel.ts";
import type { Settings } from "./settings.ts";

export interface FilePanelsParams {
  settings: Settings;
  filePanelAvailable: boolean;
  selectedPaneId: string | null;
  selectedMachineId: string;
}

export function useFilePanels({ settings, filePanelAvailable, selectedPaneId, selectedMachineId }: FilePanelsParams) {
  // the Files dialog, and the file open in the viewer (a path as the chat or the dialog gave it)
  const [filesOpen, setFilesOpen] = useState(false);
  const { viewing, openFile, closeFile, setPresentation, releaseFile } = useFileViewer();
  // a repository diff from the Files dialog's Changes tab, an entry of its own like a file
  const { viewing: diffViewing, openDiff, closeDiff, releaseDiff } = useRepoDiffViewer();
  const presentation = viewing?.presentation ?? openPresentation(viewing?.path ?? "", settings.fileOpen);
  const fileDocked = filePanelAvailable && presentation === "panel";
  useEffect(() => {
    if (viewing !== null && fileDocked) setFilesOpen(false);
  }, [viewing, fileDocked]);
  // a page this PC serves, beside the pane in the file panel's place: a file docked there replaces it
  const [webPage, setWebPage] = useState<string | null>(null);
  useEffect(() => {
    if (viewing !== null && fileDocked) setWebPage(null);
  }, [viewing, fileDocked]);
  const openWebPage = useCallback((uri: string, shiftKey: boolean, machineId: string) => {
    if (machineId !== LOCAL_MACHINE || !wantsPanel(settings.webLinks, shiftKey)) return false;
    const url = panelUrl(uri, window.location);
    if (url === null) return false;
    if (viewing !== null && fileDocked) closeFile();
    setWebPage(url);
    return true;
  }, [settings.webLinks, viewing, fileDocked, closeFile]);
  // the panel is no dialog, so no trap gives the focus back when it closes: what opened the file
  // (a link in the chat, a row of Files) gets it, as it does from the popup
  useFocusReturn(viewing !== null && fileDocked);
  // a collapse (below) whose two steps back have not landed: a second click on Show beside the
  // pane, or the kind correction in the same moment, must not queue two steps more and the file twice
  const collapsing = useRef(false);
  // a collapse whose step back never lands must not lock the toggle once the file and diff are gone
  useEffect(() => { if (viewing === null && diffViewing === null) collapsing.current = false; }, [viewing, diffViewing]);
  const presentFile = useCallback((next: FilePresentation) => {
    if (collapsing.current) return;
    if (next === "panel" && filePanelAvailable && diffViewing !== null && viewing !== null) {
      // Collapse the stacked diff and popup to one panel entry. Pushing from their opener
      // also discards the old forward entries, so Forward cannot resurrect the popup or diff.
      const preview = { ...viewing, presentation: next };
      collapsing.current = true;
      window.addEventListener("popstate", () => {
        collapsing.current = false;
        releaseDiff();
        openFile(preview);
      }, { once: true });
      window.history.go(-2);
    } else setPresentation(next);
  }, [filePanelAvailable, diffViewing, viewing, releaseDiff, openFile, setPresentation]);
  // the kind corrects a guess from the extension; with files set to open in the popup there is no guess to correct
  const reportFileKind = useCallback((kind: FilePresentation) => {
    const wanted = settings.fileOpen === "panel" ? kind : "popup";
    if (viewing !== null && viewing.presentation === undefined && wanted !== openPresentation(viewing.path, settings.fileOpen)) presentFile(wanted);
  }, [viewing, presentFile, settings.fileOpen]);
  const toggleFilePresentation = filePanelAvailable && viewing !== null
    ? () => presentFile(fileDocked ? "popup" : "panel")
    : undefined;
  const viewFile = useCallback((path: string) => {
    // the Files dialog would cover the docked panel the file opens in
    if (filePanelAvailable && openPresentation(path, settings.fileOpen) === "panel") setFilesOpen(false);
    openFile({ path, paneId: selectedPaneId, machineId: selectedMachineId });
  }, [openFile, selectedPaneId, selectedMachineId, filePanelAvailable, settings.fileOpen]);
  return { filesOpen, setFilesOpen, viewing, openFile, closeFile, setPresentation, releaseFile, diffViewing, openDiff, closeDiff, releaseDiff, presentation, fileDocked, webPage, setWebPage, openWebPage, collapsing, presentFile, reportFileKind, toggleFilePresentation, viewFile };
}
