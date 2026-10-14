import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Search, X } from "lucide-react";
import { searchLoadedChatRows, type ChatSearchMatch, type ChatSearchRow } from "../lib/chatSearch.ts";
import { useT } from "../lib/i18n.ts";
import "./FindBar.css";
import "./ChatFind.css";

export function ChatFind({ rows, older, olderState, onOlder, onMatch, onClose }: {
  rows: readonly ChatSearchRow[];
  older: boolean;
  olderState: "idle" | "loading" | "failed";
  onOlder: () => Promise<void>;
  onMatch: (match: ChatSearchMatch | null) => void;
  onClose: () => void;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [chosen, setChosen] = useState<{ rowKey: string; occurrence: number } | null>(null);
  const [searchingEarlier, setSearchingEarlier] = useState(false);
  const [pending, setPending] = useState(false);
  const priorRows = useRef(new Set<string>());
  const requestedEarlier = useRef(false);
  const mounted = useRef(true);
  const result = useMemo(() => searchLoadedChatRows(rows, query, matchCase), [rows, query, matchCase]);
  const inChosenRow = chosen === null ? [] : result.matches.filter((match) => match.rowKey === chosen.rowKey);
  const chosenMatch = chosen === null ? undefined : inChosenRow[Math.min(chosen.occurrence, inChosenRow.length - 1)];
  const chosenIndex = chosenMatch === undefined ? -1 : result.matches.indexOf(chosenMatch);
  const index = chosenIndex < 0 ? 0 : chosenIndex;
  const match = result.matches[index] ?? null;
  const text = match === null ? "" : rows.find((row) => row.key === match.rowKey)?.text ?? "";
  const reportMatch = useRef(onMatch);
  reportMatch.current = onMatch;
  useLayoutEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    reportMatch.current(match);
  }, [match?.rowKey, match?.start, match?.end, query]);

  useEffect(() => {
    if (!searchingEarlier || pending) return;
    const found = result.matches.filter((candidate) => !priorRows.current.has(candidate.rowKey)).at(-1);
    if (found) {
      setChosen({ rowKey: found.rowKey, occurrence: result.matches.filter((match) => match.rowKey === found.rowKey).indexOf(found) });
      setSearchingEarlier(false); return;
    }
    if (!older || (olderState === "failed" && requestedEarlier.current)) { setSearchingEarlier(false); return; }
    if (olderState === "loading") return;
    requestedEarlier.current = true;
    setPending(true);
    void onOlder().finally(() => { if (mounted.current) setPending(false); });
  }, [searchingEarlier, pending, result, older, olderState, onOlder]);

  const next = (direction: -1 | 1) => {
    const match = result.matches[(index + direction + result.count) % result.count];
    if (match) setChosen({ rowKey: match.rowKey, occurrence: result.matches.filter((candidate) => candidate.rowKey === match.rowKey).indexOf(match) });
  };
  return <form className="find-bar chat-find" role="search" aria-label={t("Find in messages")}
    onSubmit={(event) => { event.preventDefault(); next(1); }}
    onKeyDown={(event) => {
      // Safari sends the Enter that commits IME text with isComposing false and keyCode 229
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
      // only the field's Enter steps through matches: Enter on a button presses that button
      if (event.key === "Enter" && event.target === input.current) { event.preventDefault(); next(event.shiftKey ? -1 : 1); }
    }}>
    <div className="find-bar-controls">
      <label className="find-bar-query">
        <Search size={16} aria-hidden="true" />
        <span className="visually-hidden">{t("Find in messages")}</span>
        <input ref={input} className="input" type="search" value={query} maxLength={1024} placeholder={t("Find in messages")}
          onChange={(event) => { setQuery(event.target.value); setChosen(null); setSearchingEarlier(false); }} />
      </label>
      <span className="find-bar-count" role="status">{query ? result.count ? t("{current} of {total}", { current: index + 1, total: result.count }) : t("No matches") : ""}</span>
      <button className="icon-button" type="button" aria-label={t("Previous match")} disabled={!result.count} onClick={() => next(-1)}><ArrowUp size={16} /></button>
      <button className="icon-button" type="button" aria-label={t("Next match")} disabled={!result.count} onClick={() => next(1)}><ArrowDown size={16} /></button>
      <button className="icon-button" type="button" aria-label={t("Close search")} onClick={onClose}><X size={16} /></button>
    </div>
    <div className="chat-find-options">
      <label><input type="checkbox" checked={matchCase} onChange={(event) => { setMatchCase(event.target.checked); setChosen(null); }} />{t("Match case")}</label>
      {searchingEarlier
        ? <button type="button" className="btn btn-ghost" onClick={() => setSearchingEarlier(false)}>{t("Cancel search")}</button>
        : older && <button type="button" className="btn btn-ghost" disabled={!query || pending || olderState === "loading"} onClick={() => {
          priorRows.current = new Set(rows.map((row) => row.key));
          requestedEarlier.current = false;
          setSearchingEarlier(true);
        }}>{t("Search earlier messages")}</button>}
    </div>
    <p className="find-bar-hint">{searchingEarlier ? t("Searching earlier messages…") : t("Matches in loaded message source, including folded content.")}</p>
    {olderState === "failed" && <p className="find-bar-error" role="alert">{t("Couldn't load earlier messages — retry")}</p>}
    {match !== null && <pre className="chat-find-preview" aria-label={t("Matching source")}>
      {match.start > 80 ? "…" : ""}{text.slice(Math.max(0, match.start - 80), match.start)}<mark>{text.slice(match.start, match.end)}</mark>{text.slice(match.end, match.end + 120)}{text.length > match.end + 120 ? "…" : ""}
    </pre>}
  </form>;
}
