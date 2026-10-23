/** How the file viewer shows a file. */
export type FileKind = "image" | "video" | "audio" | "pdf" | "text" | "binary";

/**
 * GET /api/fs/stat: a file the viewer can open (GET /api/fs/file streams it). An HTML page is
 * `text` with `mime` "text/html": `/api/fs/file` serves it as plain text, and as the page itself
 * only with `render=1`, in a sandbox with no origin and no network of its own.
 */
export interface FileInfo {
  path: string;
  name: string;
  size: number;
  /** ISO time of the last change */
  modified: string;
  mime: string;
  kind: FileKind;
}

/**
 * GET /api/fs/favicon?root=: the icon the project in folder `root` keeps, or null. The PC looks
 * through every place a project keeps one (`FAVICON_CANDIDATES` in server/project-favicon.ts),
 * best first, each read as /api/fs/stat reads `<root>/<place>`, and answers once: a folder with
 * no icon is `{ icon: null }`, never a 404. 400 missing_root; the access rules of /api/fs/stat
 * (no watching device, no other site's page).
 */
export interface ProjectFavicon {
  /** the image found; `path` opens it through /api/fs/file */
  icon: FileInfo | null;
}
