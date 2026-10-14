import {
  File, FileArchive, FileAudio, FileCode, FileCog, FileDiff, FileDigit, FileImage, FileJson, FileKey, FileLock,
  FileSpreadsheet, FileTerminal, FileText, FileType, FileVideo, Folder, FolderGit, type LucideIcon,
} from "lucide-react";

import { fileIconKind, folderIconKind, type FileIconKind, type FolderIconKind } from "../lib/fileIcons.ts";

const FILE_GLYPHS: Record<FileIconKind, LucideIcon> = {
  file: File, code: FileCode, json: FileJson, config: FileCog, text: FileText, image: FileImage, video: FileVideo,
  audio: FileAudio, archive: FileArchive, shell: FileTerminal, lock: FileLock, diff: FileDiff, font: FileType,
  key: FileKey, binary: FileDigit, spreadsheet: FileSpreadsheet,
};

const FOLDER_GLYPHS: Record<FolderIconKind, LucideIcon> = { folder: Folder, git: FolderGit };

export interface FileGlyphProps {
  /** the entry's name, or a path, whose last part names it */
  name: string;
  kind?: "file" | "directory";
  className?: string;
}

/**
 * The glyph a list draws before an entry's name (lib/fileIcons.ts decides which), hidden from
 * assistive tech since the name beside it says the same. The row's CSS sizes and colors it, as it
 * does any other lucide glyph; `data-kind` names the kind for a style or a script that reads it.
 */
export function FileGlyph({ name, kind = "file", className }: FileGlyphProps) {
  const [Glyph, glyphKind] = kind === "directory" ? folderGlyph(name) : fileGlyph(name);
  return <Glyph aria-hidden="true" className={className} data-kind={glyphKind} />;
}

function fileGlyph(name: string): [LucideIcon, FileIconKind] {
  const glyphKind = fileIconKind(name);
  return [FILE_GLYPHS[glyphKind], glyphKind];
}

function folderGlyph(name: string): [LucideIcon, FolderIconKind] {
  const glyphKind = folderIconKind(name);
  return [FOLDER_GLYPHS[glyphKind], glyphKind];
}
