export interface WatchStreamOptions {
  onFrame: (data: string) => void;
  onEnd: () => void;
}

/** Incremental NDJSON and frame decoder, independent of the observer process. */
export class WatchStreamParser {
  private pending = "";
  private readonly decoder = new TextDecoder();
  private ended = false;

  constructor(private readonly options: WatchStreamOptions) {}

  push(chunk: string): void {
    if (this.ended) return;
    this.pending += chunk;
    let start = 0;
    for (;;) {
      const newline = this.pending.indexOf("\n", start);
      if (newline < 0) break;
      this.line(this.pending.slice(start, newline));
      start = newline + 1;
      if (this.ended) break;
    }
    this.pending = this.ended ? "" : this.pending.slice(start);
  }

  /** Consume a final record without a newline and flush any incomplete UTF-8. */
  finish(): void {
    if (this.ended) return;
    this.line(this.pending);
    this.pending = "";
    if (!this.ended) this.flush();
  }

  private flush(): void {
    const data = this.decoder.decode();
    if (data) this.options.onFrame(data);
  }

  private line(line: string): void {
    if (!line.trim()) return;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof record !== "object" || record === null || !("type" in record)) return;
    // herdr 0.9.3 labels a frame `encoding:"ansi"`: what the bytes are; `bytes` itself is always base64
    if (record.type === "terminal.frame" && "encoding" in record && record.encoding === "ansi" && "bytes" in record && typeof record.bytes === "string") {
      const data = this.decoder.decode(Buffer.from(record.bytes, "base64"), { stream: true });
      if (data) this.options.onFrame(data);
    } else if (record.type === "terminal.closed") {
      this.ended = true;
      this.flush();
      this.options.onEnd();
    }
  }
}

export interface PaneWatchOptions extends WatchStreamOptions {
  paneId: string;
  cols: number;
  rows: number;
  /** The same socket the bridge's RPCs use, not the CLI's default session. */
  socketPath: string;
}

const STDERR_TAIL_CHARS = 4096;

/** A read-only viewport; unlike terminal attach it never owns the pane's size. */
export class PaneWatch {
  readonly exited: Promise<void>;
  private readonly proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  private killed = false;
  private ended = false;
  private stderrTail = "";

  constructor(private readonly options: PaneWatchOptions) {
    this.proc = Bun.spawn(
      [process.env["HERDR_WEB_HERDR_BIN"] || "herdr", "terminal", "session", "observe", options.paneId,
        "--cols", String(options.cols), "--rows", String(options.rows)],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, HERDR_SOCKET_PATH: options.socketPath } },
    );
    const parser = new WatchStreamParser({
      onFrame: (data) => {
        if (!this.killed && !this.ended) options.onFrame(data);
      },
      onEnd: () => {
        this.end();
        this.stopChild();
      },
    });
    // Drain both pipes before reporting exit: the last frame and failure diagnostics
    // can arrive after the process-exit notification.
    this.exited = Promise.all([this.proc.exited, this.readStdout(parser), this.readStderr()]).then(([code]) => {
      if (!this.killed && !this.ended && code !== 0) {
        console.warn(`[watch] ${options.paneId} exited (${code}): ${this.stderrTail.trim()}`);
      }
      this.end();
    });
  }

  private async readStdout(parser: WatchStreamParser): Promise<void> {
    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!this.killed) parser.push(decoder.decode(value, { stream: true }));
      }
      if (!this.killed) {
        parser.push(decoder.decode());
        parser.finish();
      }
    } catch (error) {
      if (!this.killed && !this.ended) {
        console.warn(`[watch] ${this.options.paneId} stdout failed: ${error instanceof Error ? error.message : String(error)}`);
        this.stopChild();
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async readStderr(): Promise<void> {
    const reader = this.proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.stderrTail = (this.stderrTail + decoder.decode(value, { stream: true })).slice(-STDERR_TAIL_CHARS);
      }
      this.stderrTail = (this.stderrTail + decoder.decode()).slice(-STDERR_TAIL_CHARS);
    } catch {
      // The process can close the pipe underneath us; retain the tail already read.
    } finally {
      reader.releaseLock();
    }
  }

  private end(): void {
    if (this.killed || this.ended) return;
    this.ended = true;
    this.options.onEnd();
  }

  private stopChild(): void {
    try { this.proc.kill(); } catch { /* already exited */ }
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.stopChild();
  }
}
