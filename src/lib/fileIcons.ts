import { pathParts } from "./filePaths.ts";

/**
 * What a list draws before an entry's name so code, images, JSON and folders can be told apart at
 * a glance: a kind read from the name alone, which components/FileGlyph.tsx turns into one lucide
 * glyph each. The name is the only input, as the lists have nothing else, so a wrong extension
 * gets a wrong glyph, and no kind says anything the name beside it does not.
 */
export type FileIconKind =
  | "file" | "code" | "json" | "config" | "text" | "image" | "video" | "audio"
  | "archive" | "shell" | "lock" | "diff" | "font" | "key" | "binary" | "spreadsheet";

/** A folder is one glyph, except a repository's own `.git`. */
export type FolderIconKind = "folder" | "git";

// by extension, lowercased
const EXTENSIONS: Record<Exclude<FileIconKind, "file">, string[]> = {
  code: [
    "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "vue", "svelte", "astro",
    "py", "pyi", "rb", "rs", "go", "java", "kt", "kts", "swift", "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "m", "mm",
    "cs", "php", "lua", "dart", "scala", "ex", "exs", "erl", "hs", "zig", "r", "pl", "pm", "clj", "cljs", "elm", "ml", "mli",
    "fs", "nim", "cr", "jl", "sol", "sql", "html", "htm", "xhtml", "xml", "css", "scss", "sass", "less", "styl", "graphql", "gql", "proto",
  ],
  json: ["json", "jsonc", "json5", "geojson", "webmanifest"],
  config: ["yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties", "plist", "editorconfig"],
  text: ["md", "markdown", "mdx", "mkd", "txt", "text", "rst", "adoc", "asciidoc", "org", "log", "pdf", "doc", "docx", "rtf", "odt"],
  image: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "icns", "avif", "heic", "heif", "tif", "tiff", "psd"],
  video: ["mp4", "m4v", "mov", "webm", "mkv", "avi", "wmv", "flv", "mpg", "mpeg"],
  audio: ["mp3", "wav", "ogg", "oga", "opus", "flac", "m4a", "aac", "wma", "aiff", "aif", "mid", "midi"],
  archive: ["zip", "tar", "gz", "tgz", "bz2", "tbz", "xz", "txz", "zst", "7z", "rar", "jar", "war", "dmg", "pkg", "deb", "rpm", "iso", "apk"],
  shell: ["sh", "bash", "zsh", "fish", "ksh", "bat", "cmd", "ps1", "psm1", "psd1", "nu"],
  lock: ["lock", "lockb"],
  diff: ["diff", "patch"],
  font: ["ttf", "otf", "woff", "woff2", "eot"],
  key: ["pem", "key", "crt", "cer", "der", "p12", "pfx", "pub", "asc", "gpg", "keystore", "jks"],
  binary: ["exe", "dll", "so", "dylib", "o", "a", "lib", "obj", "class", "pyc", "pyo", "wasm", "bin", "node"],
  spreadsheet: ["csv", "tsv", "xls", "xlsx", "ods", "numbers"],
};

const BY_EXTENSION: ReadonlyMap<string, FileIconKind> = new Map(
  (Object.keys(EXTENSIONS) as Exclude<FileIconKind, "file">[]).flatMap((kind) => EXTENSIONS[kind].map((extension) => [extension, kind] as const)),
);

// whole names, lowercased, before the extension: a lockfile's extension says JSON or YAML, and a
// README, a LICENSE or a Makefile has no extension to speak of
const BY_NAME: Readonly<Record<string, FileIconKind>> = {
  "package-lock.json": "lock", "npm-shrinkwrap.json": "lock", "pnpm-lock.yaml": "lock", "go.sum": "lock",
  dockerfile: "config", containerfile: "config", makefile: "config", gnumakefile: "config", "cmakelists.txt": "config", justfile: "config", procfile: "config",
  ".gitignore": "config", ".gitattributes": "config", ".gitmodules": "config", ".dockerignore": "config", ".npmignore": "config",
  ".editorconfig": "config", ".npmrc": "config", ".nvmrc": "config", ".prettierrc": "config", ".eslintrc": "config", ".babelrc": "config", ".prettierignore": "config",
  readme: "text", license: "text", licence: "text", copying: "text", changelog: "text", notice: "text", authors: "text", contributing: "text",
  ".bashrc": "shell", ".zshrc": "shell", ".profile": "shell", ".bash_profile": "shell", ".zprofile": "shell", ".bash_aliases": "shell",
};

/** The kind of glyph for a file, from the name at the end of `path` (either separator), case-insensitively. */
export function fileIconKind(path: string): FileIconKind {
  const { stem, extension } = pathParts(path.toLowerCase());
  const name = stem + extension;
  const named = BY_NAME[name];
  if (named !== undefined) return named;
  // `.env.local` and `Dockerfile.dev` carry their kind in the stem, their extension says nothing
  if (name === ".env" || name.startsWith(".env.")) return "config";
  if (name.startsWith("dockerfile.") || name.endsWith(".dockerfile")) return "config";
  return (extension !== "" ? BY_EXTENSION.get(extension.slice(1)) : undefined) ?? "file";
}

/** The kind of glyph for a folder, from its name. */
export function folderIconKind(name: string): FolderIconKind {
  return name === ".git" ? "git" : "folder";
}
