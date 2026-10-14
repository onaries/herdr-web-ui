import { expect, test } from "bun:test";
import { readFilePreviewText } from "./filePreviewText.ts";

test("an HTTP error never becomes preview text, and its body is cancelled", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 401 });
  await expect(readFilePreviewText(response, 10)).rejects.toThrow("could not be opened");
  expect(cancelled).toBe(true);
});

test("a peer ignoring Range cannot grow the preview beyond the byte budget", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("abcdef")); }, cancel() { cancelled = true; } }));
  expect(await readFilePreviewText(response, 4)).toEqual({ text: "abcd", truncated: true });
  expect(cancelled).toBe(true);
});

test("UTF-8 splits survive and a budget does not invent a partial final character", async () => {
  const encoded = new TextEncoder().encode("한글");
  const response = () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encoded.slice(0, 2)); controller.enqueue(encoded.slice(2)); controller.close();
  } }));
  expect(await readFilePreviewText(response(), 10)).toEqual({ text: "한글", truncated: false });
  expect(await readFilePreviewText(response(), 4)).toEqual({ text: "한", truncated: true });
});

test("cancellation and a stalled body deadline release the reader even if cancellation stalls", async () => {
  let cancelled = 0;
  const response = () => new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }));
  await expect(readFilePreviewText(response(), 10, { timeoutMs: 10 })).rejects.toThrow("timed out");
  const abort = new AbortController();
  const pending = readFilePreviewText(response(), 10, { signal: abort.signal });
  abort.abort();
  await expect(pending).rejects.toThrow("aborted");
  expect(cancelled).toBe(2);
});

test("a partial range exposes truncation and rejects malformed range metadata", async () => {
  const partial = new Response("abc", { status: 206, headers: { "content-range": "bytes 0-2/6" } });
  expect(await readFilePreviewText(partial, 10)).toEqual({ text: "abc", truncated: true, total: 6 });
  await expect(readFilePreviewText(new Response("abc", { status: 206 }), 10)).rejects.toThrow("range");
});

test("a 206 cut at the budget names the whole size, and a 200 of exactly the budget is complete", async () => {
  const ranged = new Response("abcd", { status: 206, headers: { "content-range": "bytes 0-3/10" } });
  expect(await readFilePreviewText(ranged, 4)).toEqual({ text: "abcd", truncated: true, total: 10 });
  const exact = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("abcd")); controller.close(); } }));
  expect(await readFilePreviewText(exact, 4)).toEqual({ text: "abcd", truncated: false });
  const longer = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("abcd")); controller.enqueue(new TextEncoder().encode("e")); } }));
  expect(await readFilePreviewText(longer, 4)).toEqual({ text: "abcd", truncated: true });
});
