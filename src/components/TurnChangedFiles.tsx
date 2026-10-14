import { createContext, useContext, useState } from "react";
import type { ConversationPart } from "../../shared/protocol.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { useT } from "../lib/i18n.ts";
import { diffErrorMessage, type RepoDiffTarget } from "../lib/repoDiff.ts";
import { repositoryTurnPath, turnChangedFiles } from "../lib/turnChangedFiles.ts";
import "./TurnChangedFiles.css";

export const ChatDiffContext = createContext<{
  openDiff: (target: RepoDiffTarget) => void;
  cwd: string | null;
} | null>(null);

/** The turn's paths are historical; opening one compares the current working tree. */
export function TurnChangedFiles({ paneId, parts }: { paneId: string; parts: readonly ConversationPart[] }) {
  const t = useT();
  const context = useContext(ChatDiffContext);
  const machineId = useMachineId();
  const { fetchRepoDiffFiles } = useMachineApi();
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const files = turnChangedFiles(parts);
  if (files.length === 0) return null;
  const open = async (path: string): Promise<void> => {
    if (context === null) return;
    setOpening(path);
    setError(null);
    const query = { paneId, directory: context.cwd, scope: "workspace", base: null, head: null } as const;
    try {
      const list = await fetchRepoDiffFiles(query);
      const relative = repositoryTurnPath({ path, cwd: context.cwd, root: list.repository.root });
      if (relative === null) {
        setError(t("This file is outside the pane's repository."));
        return;
      }
      const file = list.files.find((item) => item.path === relative || item.old_path === relative);
      context.openDiff({ ...query, machineId, directory: list.repository.root, path: file?.path ?? relative, oldPath: file?.old_path ?? null });
    } catch (cause) {
      setError(diffErrorMessage(t, cause));
    } finally {
      setOpening(null);
    }
  };
  return <section className="turn-changed-files" aria-label={t("Files edited in this turn")}>
    <p className="turn-changed-files-title">{t("Files edited in this turn")} <span>· {t("Working tree")}</span></p>
    <ul>{files.map((path) => <li key={path}>{context === null ? path : <button type="button" disabled={opening !== null} title={t("Open working-tree diff for {path}", { path })} onClick={() => void open(path)}>{path}</button>}</li>)}</ul>
    {opening !== null && <p role="status">{t("Opening…")}</p>}
    {error !== null && <p className="chat-copy-error" role="alert">{error}</p>}
  </section>;
}
