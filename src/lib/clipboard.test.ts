import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { copyText } from "./clipboard.ts";

// bun:test has no DOM: the few pieces copyText touches are stood in for, and the copy command
// "copies" whatever text field is focused and selected when it runs
class FakeElement { focused = 0; focus(): void { this.focused += 1; dom.active = this; } }
class FakeInput extends FakeElement {
  selectionStart = 0; selectionEnd = 0; selectionDirection = "none";
  setSelectionRange(start: number, end: number): void { this.selectionStart = start; this.selectionEnd = end; }
}
class FakeTextArea extends FakeElement {
  value = ""; readOnly = false; style: Record<string, string> = {}; selected = false; attached = false;
  selectionStart = 0; selectionEnd = 0; selectionDirection = "none";
  select(): void { this.selected = true; }
  remove(): void { this.attached = false; }
}

const dom = {
  active: null as FakeElement | null,
  fields: [] as FakeTextArea[],
  copyWorks: true,
  copied: null as string | null,
};
const names = ["document", "window", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement"] as const;
const saved = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const savedClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function stand(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
function clipboardApi(value: unknown): void {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true });
}

beforeEach(() => {
  Object.assign(dom, { active: null, fields: [], copyWorks: true, copied: null });
  stand("HTMLElement", FakeElement);
  stand("HTMLInputElement", FakeInput);
  stand("HTMLTextAreaElement", FakeTextArea);
  stand("window", { getSelection: () => ({ rangeCount: 0, removeAllRanges() {}, addRange() {} }) });
  stand("document", {
    get activeElement() { return dom.active; },
    body: { appendChild: (field: FakeTextArea) => { field.attached = true; } },
    createElement: () => { const field = new FakeTextArea(); dom.fields.push(field); return field; },
    execCommand: (command: string) => {
      const field = dom.active;
      if (command !== "copy" || !dom.copyWorks || !(field instanceof FakeTextArea) || !field.attached || !field.selected) return false;
      dom.copied = field.value;
      return true;
    },
  });
});

afterEach(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  if (savedClipboard) Object.defineProperty(navigator, "clipboard", savedClipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
});

describe("copyText", () => {
  it("copies with the browser's copy command where there is no clipboard API (plain HTTP)", async () => {
    clipboardApi(undefined);
    const button = new FakeElement();
    button.focus();
    expect(await copyText("make test")).toBe(true);
    expect(dom.copied).toBe("make test");
    expect(dom.fields.map((field) => field.attached)).toEqual([false]);
    expect(dom.active).toBe(button);
  });

  it("falls back to the copy command when the clipboard API refuses", async () => {
    clipboardApi({ writeText: () => Promise.reject(new DOMException("Denied", "NotAllowedError")) });
    expect(await copyText("ls -la")).toBe(true);
    expect(dom.copied).toBe("ls -la");
  });

  it("leaves focus where the user moved it while a refused clipboard API kept them waiting", async () => {
    const button = new FakeElement();
    const composer = new FakeInput();
    button.focus();
    clipboardApi({ writeText: () => { composer.focus(); return Promise.reject(new DOMException("Denied", "NotAllowedError")); } });
    expect(await copyText("late")).toBe(false);
    expect(dom.active).toBe(composer);
    expect(composer.focused).toBe(1);
    expect(dom.fields).toEqual([]);
  });

  it("reports failure, not success, when the copy command is refused too", async () => {
    clipboardApi(undefined);
    dom.copyWorks = false;
    expect(await copyText("never copied")).toBe(false);
    expect(dom.copied).toBeNull();
    expect(dom.fields.map((field) => field.attached)).toEqual([false]);
  });
});
