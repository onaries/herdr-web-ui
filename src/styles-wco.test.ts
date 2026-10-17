import { describe, expect, it } from "bun:test";

const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();

/** Body of the first `@media <query> { ... }` block, found by matching braces. */
function mediaBody(query: string): string {
  const start = css.indexOf(`@media ${query} {`);
  if (start < 0) throw new Error(`no @media ${query} block in styles.css`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") depth -= 1;
    if (depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unclosed @media ${query} block in styles.css`);
}

describe("window-controls-overlay styles", () => {
  it("makes .app-header drag the window and pads it clear of the window controls", () => {
    const block = mediaBody("(display-mode: window-controls-overlay)");
    const header = /\.app-header\s*\{([^}]*)\}/.exec(block)?.[1] ?? "";
    expect(header).toContain("app-region: drag;");
    expect(header).toContain("env(titlebar-area-x");
    expect(header).toContain("env(titlebar-area-width");

    const controls =
      /\.app-header\s*:is\(button,\s*a,\s*input,\s*select,\s*textarea,\s*\[tabindex\]\)\s*\{([^}]*)\}/.exec(
        block,
      )?.[1] ?? "";
    expect(controls).toContain("app-region: no-drag;");
  });
});
