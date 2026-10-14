import { useCallback, useEffect, useState } from "react";
import { Code, Download, ExternalLink, X } from "lucide-react";
import "./FileViewer.css";
import { DirectoryBrowser } from "./DirectoryBrowser.tsx";
import { Markdown, MarkdownImageContext } from "./Markdown.tsx";

import type { FileInfo } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { formatBytes } from "../lib/bridgeProgress.ts";
import { LOCAL_MACHINE } from "../../shared/machines.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { useT } from "../lib/i18n.ts";
import { MAX_INLINE_IMAGE_BYTES, markdownImagePreview } from "../lib/markdownImages.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { readFilePreviewText } from "../lib/filePreviewText.ts";
import { readerHref } from "../lib/fileReader.ts";

/** Text shows its first part: the rest is a download away. */
const TEXT_PREVIEW_BYTES = 256 * 1024;

export interface FileViewerProps {
  /** absolute, `~/…`, or relative to the pane's folder */
  path: string;
  paneId: string | null;
  onClose: () => void;
  /** Settings can open above this preview; its Escape must not also close the file. */
  keyboardActive?: boolean;
  /** a file chosen in a folder's listing: opened as the preview, so history and a reload keep it */
  onOpen?: (path: string) => void;
  /** the document is the page (a markdown file's own tab, FileReader): no dialog, nothing to close */
  page?: boolean;
}

/**
 * A file an agent wrote, opened in the browser: images, video and audio (streamed, so they
 * play and seek at once), PDFs, and the start of a text file (markdown drawn, its images read through the file endpoint). Anything can be downloaded.
 */
export function FileViewer({ path: asked, paneId, onClose, onOpen, keyboardActive = true, page = false }: FileViewerProps) {
  const t = useT();
  const { fetchFileInfo, fileUrl, fetchDirectories } = useMachineApi();
  // a remote PC's bridge reads a relative folder from the pane's folder only from its next bundle
  // on; until then it would list the bridge's own folder, so only an absolute or ~/ one is listed there
  const machineId = useMachineId();
  const remote = machineId !== LOCAL_MACHINE;
  const [directory, setDirectory] = useState<string | null>(null);
  // the path as given, until a choice among files of that name replaces it
  const [path, setPath] = useState(asked);
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [candidates, setCandidates] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [textTruncated, setTextTruncated] = useState(false);
  const [textTotal, setTextTotal] = useState<number | undefined>(undefined);
  // Escape closes it, Tab stays in it, and the focus goes back to the row that opened it
  const surface = useFocusTrap<HTMLElement>(!page);
  useSheetSwipe(surface, page ? null : onClose);
  useEffect(() => setPath(asked), [asked]);

  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    setTextTruncated(false); setTextTotal(undefined);
    setInfo(null); setCandidates(null); setError(null); setText(null); setDirectory(null);
    fetchFileInfo(path, paneId).then(async (next) => {
      if (cancelled) return;
      if ("candidates" in next) { setCandidates(next.candidates); return; }
      setInfo(next);
      if (next.kind !== "text") return;
      // only the first part of a text file travels: a range, whatever the file's size
      deadline = setTimeout(() => abort.abort(), 5_000);
      try {
        const response = await fetch(fileUrl(next.path, paneId), { signal: abort.signal, headers: { range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` } });
        const body = await readFilePreviewText(response, TEXT_PREVIEW_BYTES, { signal: abort.signal });
        if (!cancelled) { setText(body.text); setTextTruncated(body.truncated); setTextTotal(body.total); }
      } finally { clearTimeout(deadline); }
    }).catch(async (reason: unknown) => {
      if (cancelled) return;
      // a folder is listed from the pane's folder, as a file is found from it
      if (reason instanceof ApiError && reason.status === 404 && (!remote || /^(?:\/|~(?:\/|$)|[A-Za-z]:[\\/])/.test(path))) {
        try {
          const listing = await fetchDirectories(path, false, true, paneId);
          if (!cancelled) setDirectory(listing.path);
          return;
        } catch { /* retain the file error when the target is not a readable directory */ }
      }
      if (cancelled) return;
      setError(reason instanceof ApiError && reason.status === 404 ? t("No readable file at this path.") : t("The file could not be opened."));
    });
    return () => { cancelled = true; clearTimeout(deadline); abort.abort(); };
  }, [path, paneId, fetchFileInfo, fileUrl, fetchDirectories, remote]);

  useEffect(() => {
    if (!keyboardActive || page) return;
    // the FilesDialog beneath listens on window too (and stands down while this is open); this
    // one is the topmost overlay, so it takes the key, unless a native modal (Add PC) is over it
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape" && !nativeModalOver(surface.current)) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, keyboardActive, page]);

  // the file found (a bare name may have been found deeper in the folder), else as asked
  const url = fileUrl(info?.path ?? path, paneId);
  const filePath = info?.path ?? path;
  const markdown = info?.kind === "text" && /\.(?:md|markdown)$/i.test(info.name);
  // a page of just the document, not the app over it (FileReader)
  const previewUrl = readerHref(machineId, filePath);
  // images of a markdown file load through the file endpoint, as the file itself does
  const imagePreview = useCallback((src: string) => markdownImagePreview(
    src, filePath, (target) => fetchFileInfo(target, paneId), (target, download) => fileUrl(target, paneId, download),
  ), [filePath, paneId, fetchFileInfo, fileUrl]);
  const body = (() => {
    if (directory !== null) return <DirectoryBrowser key={directory} start={directory} onOpenFile={onOpen ?? setPath} />;
    if (error !== null) return <p className="file-viewer-note" role="alert">{error}</p>;
    if (candidates !== null) return <div className="file-viewer-choices">
      <p className="file-viewer-note">Several files are named {path.split("/").pop()}:</p>
      <ul>{candidates.map((candidate) => <li key={candidate}><button type="button" className="btn btn-ghost" onClick={() => setPath(candidate)}>{candidate}</button></li>)}</ul>
    </div>;
    if (info === null) return <p className="file-viewer-note">{t("Opening…")}</p>;
    switch (info.kind) {
      case "image":
        return info.size > MAX_INLINE_IMAGE_BYTES
          ? <p className="file-viewer-note">{t("This image is {size}; download it to view.", { size: formatBytes(info.size) })}</p>
          : <img className="file-viewer-media" src={url} alt={info.name} />;
      case "video":
        return <video className="file-viewer-media" src={url} controls playsInline preload="metadata" />;
      case "audio":
        return <audio className="file-viewer-audio" src={url} controls preload="metadata" />;
      case "pdf":
        return <iframe className="file-viewer-pdf" src={url} title={info.name} />;
      case "text":
        return text === null ? <p className="file-viewer-note">{t("Opening…")}</p> : <>
          {markdown
            ? <MarkdownImageContext.Provider value={imagePreview}><Markdown className="file-viewer-markdown" html>{text}</Markdown></MarkdownImageContext.Provider>
            : <pre className="file-viewer-text">{text}</pre>}
          {textTruncated && (textTotal ?? 0) <= TEXT_PREVIEW_BYTES ? <p className="file-viewer-note">{t("Only part of this file is shown. Download it to read the rest.")}</p>
            : (textTotal ?? info.size) > TEXT_PREVIEW_BYTES && <p className="file-viewer-note">{t("Showing the first {shown} of {total}.", { shown: formatBytes(TEXT_PREVIEW_BYTES), total: formatBytes(textTotal ?? info.size) })}</p>}
        </>;
      default:
        return <p className="file-viewer-note">{info.mime}, {formatBytes(info.size)}. This file can't be shown here; download it instead.</p>;
    }
  })();

  const name = info?.name ?? path.split("/").pop();
  const title = <div className="file-viewer-title">
    {page ? <h1 className="modal-title">{name}</h1> : <h2 className="modal-title">{name}</h2>}
    <p className="file-viewer-meta" title={info?.path ?? path}>
      {info && <span className="file-viewer-size">{formatBytes(info.size)}</span>}
      <span className="file-viewer-path"><span dir="ltr">{info?.path ?? path}</span></span>
    </p>
  </div>;
  const download = <a className="icon-button" href={fileUrl(info?.path ?? path, paneId, true)} download={info?.name ?? true} aria-label={t("Download")} title={t("Download")}><Download aria-hidden="true" /></a>;
  if (page) return (
    <main ref={surface} className="file-reader">
      <header className="modal-header file-viewer-header file-reader-header">
        {title}
        <a className="icon-button" href={url} target="_blank" rel="noopener" aria-label={t("Open raw file")} title={t("Open raw file")}><Code aria-hidden="true" /></a>
        {download}
      </header>
      <div className="file-viewer-body file-reader-body">{body}</div>
    </main>
  );

  return (
    <div className="modal-scrim file-viewer-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={surface} className="modal file-viewer" role="dialog" aria-modal="true" aria-label={info?.name ?? path} tabIndex={-1}>
        <header className="modal-header file-viewer-header">
          {title}
          <a className="icon-button" href={markdown ? previewUrl : url} target="_blank" rel="noopener" aria-label={t("Open in a new tab")} title={t("Open in a new tab")}><ExternalLink aria-hidden="true" /></a>
          {markdown && <a className="icon-button" href={url} target="_blank" rel="noopener" aria-label={t("Open raw file")} title={t("Open raw file")}><Code aria-hidden="true" /></a>}
          {download}
          <button type="button" className="icon-button" aria-label={t("Close file")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="file-viewer-body">{body}</div>
      </section>
    </div>
  );
}
