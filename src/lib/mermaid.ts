// Mermaid, one chunk the chat loads with the first diagram it draws
// (MermaidDiagram in components/Markdown.tsx): most replies have none.
import mermaid from "mermaid";

let theme: "dark" | "default" | null = null;
let serial = 0;

/** Draws `source` as SVG markup; rejects when it is not a valid diagram. */
export async function renderMermaid(source: string, dark: boolean): Promise<string> {
  const wanted = dark ? "dark" : "default";
  if (theme !== wanted) {
    // "strict" keeps Mermaid's own sanitizer on: no click handlers, no raw HTML in labels
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: wanted });
    theme = wanted;
  }
  const id = `mermaid-diagram-${serial++}`;
  try {
    const { svg } = await mermaid.render(id, source);
    // Mermaid caps the svg at its natural width inline; the stylesheet sizes it instead (inline and zoomed)
    return svg.replace(/^(<svg[^>]*?)\sstyle="[^"]*"/, "$1");
  } finally {
    // a failed render can leave its error graphic appended to <body>
    document.getElementById(`d${id}`)?.remove();
  }
}

export default mermaid;
