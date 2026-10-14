import { describe, expect, it } from "bun:test";

import { lazyChunk, lazyChunkFailed, onLazyChunkFailure, watchPreloadErrors } from "./lazyChunk.ts";

describe("lazyChunk", () => {
  it("loads once while pending and once loaded", async () => {
    let calls = 0;
    const load = lazyChunk(async () => ++calls);
    const [a, b] = await Promise.all([load(), load()]);
    expect([a, b]).toEqual([1, 1]);
    expect(await load()).toBe(1);
    expect(calls).toBe(1);
  });

  it("keeps a failure for the page's life and tells every listener of it once", async () => {
    let calls = 0;
    let told = 0;
    const stop = onLazyChunkFailure(() => { told++; });
    const failing = onLazyChunkFailure(() => { throw new Error("a broken listener"); });
    try {
      const load = lazyChunk(async () => {
        calls++;
        if (calls === 1) throw new TypeError("Failed to fetch dynamically imported module");
        // a second try in a browser: Vite skipped the stylesheet that failed, the script loads alone
        return "katex without its styles";
      });
      await expect(load()).rejects.toThrow("Failed to fetch dynamically imported module");
      expect(told).toBe(1);
      expect(lazyChunkFailed()).toBe(true);
      // only a reload fetches it again: a second try would draw math unstyled
      await expect(load()).rejects.toThrow("Failed to fetch dynamically imported module");
      expect(calls).toBe(1);
      expect(told).toBe(1);
    } finally {
      stop();
      failing();
    }
  });

  it("stops telling a listener that was removed", async () => {
    let told = 0;
    onLazyChunkFailure(() => { told++; })();
    await expect(lazyChunk(() => Promise.reject(new Error("gone")))()).rejects.toThrow("gone");
    expect(told).toBe(0);
  });

  it("tells of a chunk a lazy part loads on its own once Vite's loader reports it", () => {
    // Mermaid's entry loaded; the chunk of a diagram type it asks for later is gone. Mermaid turns
    // that into a failed render, which reaches no lazyChunk: Vite's loader is what tells of it
    const window = new EventTarget();
    const unwatch = watchPreloadErrors(window);
    let told = 0;
    const stop = onLazyChunkFailure(() => { told++; });
    try {
      window.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
      expect(told).toBe(1);
      expect(lazyChunkFailed()).toBe(true);
      // the import still rejects as it would: the event is heard, not cancelled
      const event = new Event("vite:preloadError", { cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      unwatch();
      window.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
      expect(told).toBe(2);
    } finally {
      stop();
      unwatch();
    }
  });

  it("is not told of a diagram that fails only to parse", async () => {
    let told = 0;
    const stop = onLazyChunkFailure(() => { told++; });
    try {
      // the module loads; the render it gives rejects on a syntax error, not on a missing chunk
      const load = lazyChunk(async () => async () => { throw new Error("Parse error on line 1"); });
      const render = await load();
      await expect(render()).rejects.toThrow("Parse error");
      expect(told).toBe(0);
    } finally {
      stop();
    }
  });
});
