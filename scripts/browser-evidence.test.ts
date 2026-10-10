import { describe, expect, it, jest } from "bun:test";
import type { Page } from "playwright-core";
import type { BrowserEvidenceFiles, BrowserEvidencePage, BrowserEvidenceTracing } from "./browser-evidence.ts";
import { browserEvidencePage, startBrowserEvidence } from "./browser-evidence.ts";

class FakePage implements BrowserEvidencePage {
  readonly consoles: Array<(type: string, text: string) => void> = [];
  readonly pageErrors: Array<(message: string) => void> = [];
  readonly shots: string[] = [];
  readonly screenshotTimeouts: number[] = [];
  open = true;
  screenshotFailure: Error | null = null;
  screenshotGate: Promise<void> | undefined;

  onConsole(listener: (type: string, text: string) => void): void { this.consoles.push(listener); }
  onPageError(listener: (message: string) => void): void { this.pageErrors.push(listener); }
  isOpen(): boolean { return this.open; }
  async screenshot(path: string, timeoutMs: number): Promise<void> {
    this.screenshotTimeouts.push(timeoutMs);
    if (this.screenshotFailure) throw this.screenshotFailure;
    if (this.screenshotGate) await this.screenshotGate;
    this.shots.push(path);
  }
}

class FakeFiles implements BrowserEvidenceFiles {
  readonly files = new Map<string, string>();
  readonly directories: Array<{ path: string; mode: 0o700 }> = [];
  readonly writeModes: Array<{ path: string; mode: 0o600 }> = [];
  readonly permissions: Array<{ path: string; mode: 0o600 }> = [];
  directoryFailure: Error | null = null;
  metadataFailure: Error | null = null;

  async mkdir(path: string, mode: 0o700): Promise<void> {
    if (this.directoryFailure) throw this.directoryFailure;
    this.directories.push({ path, mode });
  }
  async writeFile(path: string, content: string, mode: 0o600): Promise<void> {
    if (this.metadataFailure) throw this.metadataFailure;
    this.files.set(path, content);
    this.writeModes.push({ path, mode });
  }
  async chmod(path: string, mode: 0o600): Promise<void> { this.permissions.push({ path, mode }); }
}

class FakeTracing implements BrowserEvidenceTracing {
  starts = 0;
  startOptions: { screenshots: true; snapshots: false; sources: false } | undefined;
  readonly stops: Array<string | undefined> = [];
  startGate: Promise<void> | undefined;
  stopGate: Promise<void> | undefined;
  async start(options: { screenshots: true; snapshots: false; sources: false }): Promise<void> {
    this.starts += 1;
    this.startOptions = options;
    if (this.startGate) await this.startGate;
  }
  async stop(path?: string): Promise<void> {
    this.stops.push(path);
    if (this.stopGate) await this.stopGate;
  }
}

const makeSession = (page: FakePage, files: FakeFiles, tracing?: FakeTracing) => startBrowserEvidence({
  page,
  directory: "/tmp/browser-evidence-test",
  script: "ui-regression",
  scenario: "synthetic-failure",
  trace: tracing !== undefined,
  tracing,
  files,
});

const flushMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

describe("browser evidence", () => {
  it("stays inactive without an evidence directory", async () => {
    const page = new FakePage();
    const files = new FakeFiles();
    const tracing = new FakeTracing();
    const session = await startBrowserEvidence({ page, tracing, trace: true, script: "ui-regression", scenario: "disabled", files });

    const result = await session.captureFailure(new Error("synthetic failure"));

    expect(page.consoles).toHaveLength(0);
    expect(page.pageErrors).toHaveLength(0);
    expect(page.shots).toEqual([]);
    expect(tracing.starts).toBe(0);
    expect(files.files.size).toBe(0);
    expect(result.files).toEqual([]);
  });

  it("bounds captured console and page-error messages", async () => {
    const page = new FakePage();
    const files = new FakeFiles();
    const session = await makeSession(page, files);
    for (let index = 0; index < 39; index += 1) page.consoles.forEach((listener) => listener("warning", `${index}:${"x".repeat(1_100)}`));
    page.pageErrors.forEach((listener) => listener("page exploded"));
    for (let index = 0; index < 5; index += 1) page.consoles.forEach((listener) => listener("warning", `${index}:overflow`));

    await session.captureFailure(new Error("synthetic assertion failure"));

    const metadata = JSON.parse([...files.files.values()][0]!) as { messages: Array<{ type: string; message: string }>; messagesTruncated: boolean; artifacts: { screenshot: string | null } };
    expect(metadata.messages).toHaveLength(40);
    expect(metadata.messages.every(({ message }) => message.length <= 1_000)).toBe(true);
    expect(metadata.messages.some(({ type }) => type === "pageerror")).toBe(true);
    expect(metadata.messages.at(-1)?.message).toBe("4:overflow");
    expect(metadata.messagesTruncated).toBe(true);
    expect(metadata.artifacts.screenshot).toBe(page.shots[0]);
    expect(files.directories[0]?.mode).toBe(0o700);
    expect(files.permissions).toContainEqual({ path: page.shots[0]!, mode: 0o600 });
    expect(files.permissions).toContainEqual({ path: [...files.files.keys()][0]!, mode: 0o600 });
    expect(files.writeModes).toEqual([{ path: [...files.files.keys()][0]!, mode: 0o600 }]);
  });

  it("discards an enabled trace after a successful scenario", async () => {
    const page = new FakePage();
    const files = new FakeFiles();
    const tracing = new FakeTracing();
    const session = await makeSession(page, files, tracing);

    await session.finish();

    expect(tracing.starts).toBe(1);
    expect(tracing.startOptions).toEqual({ screenshots: true, snapshots: false, sources: false });
    expect(tracing.stops).toEqual([undefined]);
    expect(files.files.size).toBe(0);
    expect(page.shots).toEqual([]);
  });

  it("retains a trace and metadata on failure without masking the original error when screenshot capture fails", async () => {
    const page = new FakePage();
    const screenshotError = new Error("synthetic screenshot failure");
    page.screenshotFailure = screenshotError;
    const files = new FakeFiles();
    const tracing = new FakeTracing();
    const session = await makeSession(page, files, tracing);
    const original = new Error("synthetic assertion failure");

    let caught: unknown;
    try {
      try {
        throw original;
      } catch (error) {
        await session.captureFailure(error);
        throw error;
      }
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(original);
    expect(tracing.stops[0]?.endsWith("ui-regression-synthetic-failure.trace.zip")).toBe(true);
    const metadata = JSON.parse([...files.files.values()][0]!) as { artifacts: { screenshot: string | null; trace: string | null }; artifactErrors: string[] };
    expect(metadata.artifacts.screenshot).toBeNull();
    expect(metadata.artifacts.trace?.endsWith("ui-regression-synthetic-failure.trace.zip")).toBe(true);
    expect(metadata.artifactErrors.some((message) => message.includes("synthetic screenshot failure"))).toBe(true);
  });

  it("reports directory failures as evidence errors instead of throwing", async () => {
    const page = new FakePage();
    const files = new FakeFiles();
    files.directoryFailure = new Error("synthetic directory failure");
    const session = await makeSession(page, files);

    const result = await session.captureFailure(new Error("original regression failure"));

    expect(result.errors.some((message) => message.includes("synthetic directory failure"))).toBe(true);
    expect(page.shots).toEqual([]);
  });

  it("passes the screenshot timeout through to Playwright", async () => {
    const options: Array<{ path: string; timeout: number }> = [];
    const page = { screenshot: async (value: { path: string; timeout: number }) => { options.push(value); } } as unknown as Page;

    await browserEvidencePage(page).screenshot("/tmp/evidence.png", 1234);

    expect(options).toEqual([{ path: "/tmp/evidence.png", timeout: 1234 }]);
  });

  it("bounds a hung screenshot and makes a late screenshot private", async () => {
    jest.useFakeTimers();
    try {
      const page = new FakePage();
      let releaseScreenshot!: () => void;
      page.screenshotGate = new Promise<void>((resolve) => { releaseScreenshot = resolve; });
      const files = new FakeFiles();
      const session = await makeSession(page, files);
      const capture = session.captureFailure(new Error("synthetic assertion failure"));
      await flushMicrotasks();

      expect(page.screenshotTimeouts).toEqual([5_000]);
      jest.advanceTimersByTime(5_000);
      await flushMicrotasks();
      const result = await capture;
      const metadata = JSON.parse([...files.files.values()][0]!) as { artifacts: { screenshot: string | null }; artifactErrors: string[] };
      expect(metadata.artifacts.screenshot).toBeNull();
      expect(metadata.artifactErrors.some((message) => message.includes("screenshot timed out after 5000ms"))).toBe(true);
      expect(result.errors.some((message) => message.includes("screenshot timed out after 5000ms"))).toBe(true);

      releaseScreenshot();
      await flushMicrotasks();
      expect(page.shots).toHaveLength(1);
      expect(files.permissions).toContainEqual({ path: page.shots[0]!, mode: 0o600 });
    } finally {
      jest.useRealTimers();
    }
  });

  it("bounds a hung trace start and stops it if it completes late", async () => {
    jest.useFakeTimers();
    try {
      const page = new FakePage();
      const files = new FakeFiles();
      const tracing = new FakeTracing();
      let releaseStart!: () => void;
      tracing.startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
      const starting = makeSession(page, files, tracing);
      await flushMicrotasks();
      expect(tracing.starts).toBe(1);

      jest.advanceTimersByTime(15_000);
      await flushMicrotasks();
      const session = await starting;
      await session.captureFailure(new Error("synthetic assertion failure"));
      const metadata = JSON.parse([...files.files.values()][0]!) as { artifactErrors: string[] };
      expect(metadata.artifactErrors.some((message) => message.includes("trace start timed out after 15000ms"))).toBe(true);

      releaseStart();
      await flushMicrotasks();
      expect(tracing.stops).toEqual([undefined]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("bounds a hung trace stop and makes a late trace private", async () => {
    jest.useFakeTimers();
    try {
      const page = new FakePage();
      const files = new FakeFiles();
      const tracing = new FakeTracing();
      let releaseStop!: () => void;
      tracing.stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
      const session = await makeSession(page, files, tracing);
      const capture = session.captureFailure(new Error("synthetic assertion failure"));
      await flushMicrotasks();
      expect(tracing.stops).toHaveLength(1);
      const tracePath = tracing.stops[0]!;

      jest.advanceTimersByTime(15_000);
      await flushMicrotasks();
      const result = await capture;
      const metadata = JSON.parse([...files.files.values()][0]!) as { artifacts: { trace: string | null }; artifactErrors: string[] };
      expect(metadata.artifacts.trace).toBeNull();
      expect(metadata.artifactErrors.some((message) => message.includes("trace stop timed out after 15000ms"))).toBe(true);
      expect(result.errors.some((message) => message.includes("trace stop timed out after 15000ms"))).toBe(true);

      releaseStop();
      await flushMicrotasks();
      expect(files.permissions).toContainEqual({ path: tracePath, mode: 0o600 });
    } finally {
      jest.useRealTimers();
    }
  });
});
