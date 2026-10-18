import { fileLineTarget, pathParts } from "./filePaths.ts";

export type FilePresentation = "panel" | "popup";
/** where a file opens until its header button moves it (Settings → Chat → File viewer): popup first by default */
export const FILE_OPEN_TARGETS = ["popup", "panel"] as const satisfies readonly FilePresentation[];

/** First paint before FileInfo arrives; unknown extensions and folders wait in the popup. */
export function filePresentation(path: string): FilePresentation {
  const { extension } = pathParts(fileLineTarget(path.trim()).path);
  return /^\.(?:txt|text|md|markdown|mdx|html?|xhtml|css|scss|sass|less|js|jsx|mjs|cjs|ts|tsx|json|jsonc|jsonl|ya?ml|toml|xml|csv|tsv|log|ini|conf|cfg|sh|bash|zsh|fish|py|pyi|rb|php|go|rs|c|h|cc|cpp|hpp|cs|java|kt|kts|swift|sql|vue|svelte|astro|ex|exs|erl|hrl|hs|lua|pl|r|jl|diff|patch|env|lock)$/i.test(extension) ? "panel" : "popup";
}

/** Where a file opens: always the popup unless Settings asks for the panel, which then takes text alone. */
export function openPresentation(path: string, open: FilePresentation): FilePresentation {
  return open === "panel" ? filePresentation(path) : "popup";
}
