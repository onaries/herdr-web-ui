import { expect, test } from "bun:test";
import { chatReadDeadlineMs, withChatReadDeadline } from "./chatReadDeadline.ts";

test("a stalled header aborts and releases the serialized reader", async () => {
  let signal: AbortSignal | undefined;
  await expect(withChatReadDeadline((next) => { signal = next; return new Promise(() => {}); }, 10)).rejects.toThrow("timed out");
  expect(signal?.aborted).toBe(true);
  expect(await withChatReadDeadline(async () => "next read", 10)).toBe("next read");
});

test("the same deadline covers the body and ignores a late result", async () => {
  let resolve!: (value: string) => void;
  const late = new Promise<string>((done) => { resolve = done; });
  const read = withChatReadDeadline(async () => { await Promise.resolve("headers"); return await late; }, 10);
  await expect(read).rejects.toThrow("timed out");
  resolve("obsolete");
  expect(await withChatReadDeadline(async () => "current", 10)).toBe("current");
});

test("success and HTTP failures preserve the original result or error", async () => {
  const error = new Error("HTTP 401");
  await expect(withChatReadDeadline(async () => { throw error; }, 10)).rejects.toBe(error);
  const result = { turns: [] };
  expect(await withChatReadDeadline(async () => result, 10)).toBe(result);
});

test("a remote PC's read, which crosses the machine proxy, waits twice as long as a local one", () => {
  expect(chatReadDeadlineMs("local")).toBe(15_000);
  expect(chatReadDeadlineMs("studio-mac")).toBe(30_000);
});
