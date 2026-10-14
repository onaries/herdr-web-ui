/** Rendered selection -> Markdown/plain code and resource-free rich HTML.
 * Adapted from t3code's markdown-clipboard.ts (MIT).
 */
export interface ClipboardNode {
  readonly tag: string;
  readonly text?: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly children?: readonly ClipboardNode[];
}

export interface MarkdownClipboardPayload {
  readonly text: string;
  readonly html: string;
}

const OMIT = new Set(["BUTTON", "INPUT", "SCRIPT", "STYLE", "TEMPLATE", "SVG", "IFRAME", "OBJECT", "EMBED", "LINK", "META"]);
const HTML_TAGS = new Set(["P", "BR", "HR", "PRE", "CODE", "STRONG", "B", "EM", "I", "DEL", "S", "A", "UL", "OL", "LI", "BLOCKQUOTE", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "H1", "H2", "H3", "H4", "H5", "H6"]);
const OMIT_CLASSES = new Set(["markdown-code-header", "markdown-code-error", "hl-note", "chat-turn-meta", "chat-meta", "sr-only"]);
const attr = (node: ClipboardNode, name: string): string | undefined => node.attrs?.[name];
const children = (node: ClipboardNode): readonly ClipboardNode[] => node.children ?? [];
const visible = (node: ClipboardNode): boolean => (!OMIT.has(node.tag) || (node.tag === "BUTTON" && (attr(node, "class") ?? "").split(/\s+/).includes("markdown-file"))) && attr(node, "aria-hidden") !== "true" && !(attr(node, "class") ?? "").split(/\s+/).some((name) => OMIT_CLASSES.has(name));
const rawText = (node: ClipboardNode): string => node.text ?? children(node).map(rawText).join("");
const escapeHtml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function inlineMarker(content: string, marker: string): string {
  return content.replace(/^(\s*)([\s\S]*?)(\s*)$/, (_, before: string, core: string, after: string) => core ? `${before}${marker}${core}${marker}${after}` : content);
}

function codeMarker(code: string, minimum: number): string {
  return "`".repeat(Math.max(minimum, ...[...(code.match(/`+/g) ?? [])].map((run) => run.length + 1)));
}

function markdown(node: ClipboardNode): string {
  const source = attr(node, "data-markdown-copy");
  if (source !== undefined) return source;
  if (!visible(node)) return "";
  if (node.text !== undefined) return node.text;
  const content = children(node).map((child) => (node.tag === "LI" && (child.tag === "UL" || child.tag === "OL") ? "\n" : "") + markdown(child)).join("");
  const heading = attr(node, "data-markdown-heading") ?? /^H([1-6])$/.exec(node.tag)?.[1];
  if (heading) return `${"#".repeat(Number(heading))} ${content.trim()}\n\n`;
  switch (node.tag) {
    case "BR": return "\n";
    case "HR": return "---\n\n";
    case "P": return `${content.trim()}\n\n`;
    case "PRE": {
      const code = rawText(node);
      const fence = codeMarker(code, 3);
      return `${fence}${attr(node, "data-language") ?? ""}\n${code}\n${fence}\n\n`;
    }
    case "CODE": {
      if (content.includes("\n") || children(node).some((child) => (attr(child, "class") ?? "").split(" ").includes("hl-line"))) return content;
      const fence = codeMarker(content, 1);
      const pad = content.startsWith("`") || content.endsWith("`") ? " " : "";
      return `${fence}${pad}${content}${pad}${fence}`;
    }
    case "STRONG": case "B": return inlineMarker(content, "**");
    case "EM": case "I": return inlineMarker(content, "*");
    case "DEL": case "S": return inlineMarker(content, "~~");
    case "A": {
      const href = attr(node, "href") ?? "";
      return /^(https?:\/\/|mailto:)/i.test(href) && content.trim() && content !== href ? `[${content}](${href})` : content;
    }
    case "IMG": return `![${attr(node, "alt") ?? ""}](${attr(node, "src") ?? ""})`;
    case "UL": case "OL": {
      const start = Number.parseInt(attr(node, "start") ?? "1", 10) || 1;
      return children(node).filter((child) => child.tag === "LI").map((item, index) => {
        const checkbox = children(item).find((child) => attr(child, "role") === "checkbox");
        const task = checkbox ? `[${attr(checkbox, "aria-checked") === "true" ? "x" : " "}] ` : "";
        const marker = node.tag === "OL" ? `${start + index}. ${task}` : `- ${task}`;
        const lines = markdown(item).trim().split("\n");
        return lines.map((line, lineIndex) => lineIndex === 0 ? marker + line : line ? " ".repeat(marker.length) + line : "").join("\n");
      }).join("\n") + "\n\n";
    }
    case "BLOCKQUOTE": return content.trim().split("\n").map((line) => line ? `> ${line}` : ">").join("\n") + "\n\n";
    case "TABLE": {
      const rows = children(node).flatMap((child) => child.tag === "TR" ? [child] : children(child).filter((row) => row.tag === "TR"));
      return rows.map((row, index) => {
        const cells = children(row).filter((cell) => cell.tag === "TH" || cell.tag === "TD");
        const line = `| ${cells.map((cell) => markdown(cell).trim().replace(/\n+/g, " ").replaceAll("|", "\\|")).join(" | ")} |`;
        return index === 0 ? `${line}\n| ${cells.map(() => "---").join(" | ")} |` : line;
      }).join("\n") + "\n\n";
    }
    case "DIV": case "SECTION": case "ARTICLE": return content && !content.endsWith("\n") ? content + "\n\n" : content;
    default: return content;
  }
}

/** Rebuild, rather than scrub arbitrary HTML: attributes cannot smuggle resources or handlers. */
function richHtml(node: ClipboardNode): string {
  if (attr(node, "data-markdown-copy") !== undefined) return escapeHtml(attr(node, "data-markdown-copy") ?? "");
  if (!visible(node)) return "";
  if (node.text !== undefined) return escapeHtml(node.text);
  if (node.tag === "IMG") return escapeHtml(attr(node, "alt") ?? "");
  const content = children(node).map(richHtml).join("");
  if (!HTML_TAGS.has(node.tag)) return content;
  const tag = node.tag.toLowerCase();
  let attributes = "";
  const href = attr(node, "href");
  if (node.tag === "A" && href && /^(https?:\/\/|mailto:)/i.test(href)) attributes = ` href="${escapeHtml(href)}"`;
  const start = attr(node, "start");
  if (node.tag === "OL" && start && /^\d+$/.test(start)) attributes = ` start="${start}"`;
  return node.tag === "BR" || node.tag === "HR" ? `<${tag}>` : `<${tag}${attributes}>${content}</${tag}>`;
}

export function renderedMarkdownPayload(nodes: readonly ClipboardNode[]): MarkdownClipboardPayload {
  const pres: ClipboardNode[] = [];
  let other = false;
  const scan = (node: ClipboardNode): void => {
    if (attr(node, "data-markdown-copy") !== undefined) { other = true; return; }
    if (!visible(node)) return;
    if (node.tag === "PRE") { pres.push(node); return; }
    if (node.text?.trim() || node.tag === "IMG" || node.tag === "HR") other = true;
    children(node).forEach(scan);
  };
  nodes.forEach(scan);
  const soleCode = !other && pres.length === 1 ? pres[0] : undefined;
  const text = soleCode ? rawText(soleCode) : nodes.map(markdown).join("").trim();
  return { text, html: nodes.map(richHtml).join("") };
}

function fromDom(node: Node): ClipboardNode {
  if (!(node instanceof Element)) return { tag: "", text: node.nodeType === 3 ? node.textContent ?? "" : "", children: [...node.childNodes].map(fromDom) };
  const attrs = Object.fromEntries([...node.attributes].map((entry) => [entry.name, entry.value]));
  if (node.tagName === "PRE") attrs["data-language"] = node.closest("[data-language]")?.getAttribute("data-language") ?? "";
  return { tag: node.tagName, attrs, children: [...node.childNodes].map(fromDom) };
}

/** Only claim a range wholly in this chat; composer fields and the terminal keep native copy. */
export function chatMarkdownClipboardPayload(selection: Selection, root: Element): MarkdownClipboardPayload | null {
  if (selection.isCollapsed || selection.rangeCount === 0) return null;
  const payloads: MarkdownClipboardPayload[] = [];
  for (let index = 0; index < selection.rangeCount; index++) {
    const range = selection.getRangeAt(index);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
    const ancestor = range.commonAncestorContainer;
    const element = ancestor instanceof Element ? ancestor : ancestor.parentElement;
    if (element?.closest("input, textarea, [contenteditable=true]")) return null;
    const container = document.createElement("div");
    container.append(range.cloneContents());
    // cloneContents drops the common ancestor and all its formatting. Restore those wrappers
    // only up to Markdown, never a virtual row or the scroller itself.
    let wrapped: Node = container;
    if (element?.closest(".markdown")) {
      for (let current: Element | null = element; current && !current.classList.contains("markdown"); current = current.parentElement) {
        const wrapper = current.cloneNode(false);
        while (wrapped.firstChild) wrapper.appendChild(wrapped.firstChild);
        const parent = document.createElement("div");
        parent.appendChild(wrapper);
        wrapped = parent;
      }
    }
    const payload = renderedMarkdownPayload([...wrapped.childNodes].map(fromDom));
    const nativeText = selection.rangeCount === 1 ? selection.toString() : range.toString();
    // A prose-only selection already is Markdown. Keep its native row separators and endpoint
    // whitespace exactly, including the blank line the virtual row layout contributes.
    const plain = payload.text.replace(/\n+/g, "\n") === nativeText.trim().replace(/\n+/g, "\n");
    const text = element?.closest("pre") || plain ? nativeText : payload.text;
    if (text) payloads.push({ ...payload, text });
  }
  return payloads.length ? { text: payloads.map((payload) => payload.text).join("\n\n"), html: payloads.map((payload) => payload.html).join("") } : null;
}
