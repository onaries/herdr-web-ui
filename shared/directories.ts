/** GET /api/workspace/directories: the folders inside one directory, for the folder browser. */
export interface DirectoryListing {
  /** the directory listed, absolute */
  path: string;
  /** its parent, or null at the root */
  parent: string | null;
  /** the user's home, so the browser can show `~` and offer a way back */
  home: string;
  /** folder names, sorted; hidden ones only when asked for */
  directories: string[];
  /** more folders than the list holds */
  truncated: boolean;
  /** the files beside the folders, when asked for (`files=1`), sorted, within the same cap */
  files?: { name: string; size: number }[];
}

/**
 * POST /api/workspace/directories: makes one folder `name` directly inside `path` (absolute,
 * `~` or `~/…`), for the folder browser's New folder. 201 with the folder made; 400
 * invalid_cwd / invalid_name (empty, `.`, `..`, a separator, over 255 bytes), 403
 * permission_denied, 409 folder_exists. Nothing is made recursively or overwritten.
 */
export interface CreateDirectoryRequest {
  path: string;
  name: string;
}

export interface DirectoryCreated {
  /** the folder made, absolute */
  path: string;
}
