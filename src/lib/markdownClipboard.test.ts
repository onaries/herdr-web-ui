import { describe, expect, test } from "bun:test";
import { renderedMarkdownPayload, type ClipboardNode } from "./markdownClipboard.ts";

const text = (value: string): ClipboardNode => ({ tag: "", text: value });
const element = (tag: string, content: readonly ClipboardNode[], attrs?: Record<string, string>): ClipboardNode => ({ tag, children: content, attrs });

describe("renderedMarkdownPayload", () => {
  test("keeps lists, emphasis, links, and heading source levels", () => {
    const nodes = [
      element("H3", [text("Plan")], { "data-markdown-heading": "1" }),
      element("UL", [
        element("LI", [element("STRONG", [text("First")])]),
        element("LI", [element("A", [text("Docs")], { href: "https://example.com" })]),
      ]),
    ];
    const payload = renderedMarkdownPayload(nodes);
    expect(payload.text).toBe("# Plan\n\n- **First**\n- [Docs](https://example.com)");
    expect(payload.html).toContain("<ul><li><strong>First</strong></li>");
  });

  test("keeps nested and ordered task list markers", () => {
    const nodes = [element("OL", [
      element("LI", [
        element("SPAN", [], { role: "checkbox", "aria-checked": "true" }),
        text("Done"),
        element("UL", [element("LI", [text("Child")])]),
      ]),
    ], { start: "3" })];
    expect(renderedMarkdownPayload(nodes).text).toBe("3. [x] Done\n       - Child");
  });

  test("copies a sole code block as plain code without losing blank lines or spaces", () => {
    const code = "  one\n\n\n  two  ";
    const nodes = [element("DIV", [
      element("DIV", [text("ts"), element("BUTTON", [text("Copy")])], { class: "markdown-code-header" }),
      element("PRE", [element("CODE", [text(code)])]),
    ])];
    expect(renderedMarkdownPayload(nodes).text).toBe(code);
  });

  test("fences code in a mixed selection without altering its whitespace", () => {
    const nodes = [
      element("P", [text("Run this")]),
      element("PRE", [element("CODE", [text("one\n\n\n```  ")])], { "data-language": "sh" }),
    ];
    expect(renderedMarkdownPayload(nodes).text).toBe("Run this\n\n````sh\none\n\n\n```  \n````");
  });

  test("preserves chip raw text and image Markdown even when an image is a fallback link", () => {
    const nodes = [element("P", [
      element("SPAN", [element("SVG", [text("icon")]), text("/review")], { class: "markdown-skill" }),
      text(" "),
      element("SPAN", [text("diagram")], { "data-markdown-copy": "![diagram](https://example.com/picture.png)" }),
    ])];
    expect(renderedMarkdownPayload(nodes).text).toBe("/review ![diagram](https://example.com/picture.png)");
  });

  test("exports rich HTML without executable attributes, embedded resources, or unsafe links", () => {
    const nodes = [
      element("P", [text('<hello & "world">')], { onclick: "alert(1)", style: "background:url(https://example.com)" }),
      element("SCRIPT", [text("alert(1)")]),
      element("IFRAME", [], { src: "https://example.com" }),
      element("IMG", [], { alt: "picture", src: "https://example.com/p.png", onerror: "alert(1)" }),
      element("A", [text("unsafe")], { href: "javascript:alert(1)" }),
      element("STRONG", [text("safe")]),
    ];
    expect(renderedMarkdownPayload(nodes).html).toBe('<p>&lt;hello &amp; &quot;world&quot;&gt;</p>picture<a>unsafe</a><strong>safe</strong>');
  });

  test("preserves quoted text and tables with escaped cell delimiters", () => {
    const nodes = [
      element("BLOCKQUOTE", [element("P", [text("Quote")])]),
      element("TABLE", [
        element("THEAD", [element("TR", [element("TH", [text("Name")])])]),
        element("TBODY", [element("TR", [element("TD", [text("a|b")])])]),
      ]),
    ];
    expect(renderedMarkdownPayload(nodes).text).toBe("> Quote\n\n| Name |\n| --- |\n| a\\|b |");
  });
});
