/** Range is a request, not a client memory limit: a peer can ignore it or a file can grow. */
export async function readFilePreviewText(response: Response, limit: number, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ text: string; truncated: boolean; total?: number }> {
  const discard = () => { void response.body?.cancel().catch(() => {}); };
  if (!response.ok) { discard(); throw new Error("The file could not be opened."); }
  if (!Number.isSafeInteger(limit) || limit < 1) { discard(); throw new Error("Invalid preview limit."); }
  const range = response.status === 206 ? /^bytes 0-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "") : null;
  if (response.status === 206 && (!range || Number(range[1]) >= Number(range[2]))) { discard(); throw new Error("Invalid file range."); }
  const reader = response.body?.getReader();
  // a 206 names the file's whole size, so a cut there can say how much is shown
  const total = range ? { total: Number(range[2]) } : {};
  if (!reader) return { text: "", truncated: range !== null, ...total };
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let stopped: Error | undefined;
  let reject!: (error: Error) => void;
  const interruption = new Promise<never>((_, fail) => { reject = fail; });
  const stop = (error: Error) => { stopped = error; reject(error); void reader.cancel().catch(() => {}); };
  const aborted = () => stop(new Error("File preview aborted."));
  const timer = setTimeout(() => stop(new Error("File preview timed out.")), options.timeoutMs ?? 5_000);
  options.signal?.addEventListener("abort", aborted, { once: true });
  try {
    if (options.signal?.aborted) { aborted(); await interruption; }
    while (true) {
      const { value, done } = await Promise.race([reader.read(), interruption]);
      if (stopped) throw stopped;
      if (done) return { text: text + decoder.decode(), truncated: range !== null && bytes < Number(range[2]), ...total };
      const remaining = limit - bytes;
      text += decoder.decode(value.subarray(0, remaining), { stream: true });
      bytes += Math.min(remaining, value.byteLength);
      if (bytes >= limit) {
        let more = value.byteLength > remaining || (range !== null && Number(range[2]) > bytes);
        // a 200 that ends exactly at the budget is the whole file: look for one more chunk before calling it cut
        if (!more && range === null) {
          const next = await Promise.race([reader.read(), interruption]);
          if (stopped) throw stopped;
          more = !next.done;
        }
        // Never wait on a remote cancellation promise, or a hostile/stalled body can hold the UI.
        void reader.cancel().catch(() => {});
        return { text: more ? text : text + decoder.decode(), truncated: more, ...total };
      }
    }
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener("abort", aborted); reader.releaseLock();
  }
}
