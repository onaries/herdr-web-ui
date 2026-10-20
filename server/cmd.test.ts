import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cmdContextWindow, cmdSlug, cmdTranscriptInStore, unwrittenSession } from "./cmd.ts";
import { transcriptPage } from "./conversation.ts";
import { parseInteractivePrompt } from "./prompt.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-cmd-store-"));
const project = join(root, "projects", cmdSlug(root));
mkdirSync(project, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const canSymlink = (() => {
  const probe = join(root, "symlink-capability");
  try { symlinkSync(project, probe, "dir"); rmSync(probe); return true; }
  catch (error) { if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return false; throw error; }
})();

const session = (name: string, body: unknown[] = []) => {
  const path = join(project, `${name}.jsonl`);
  writeFileSync(path, [
    { type: "session", version: 3, id: name, timestamp: new Date().toISOString(), cwd: root },
    ...body,
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return path;
};

describe("Command Code's session store holds the transcript a pane reads", () => {
  it("names the project directory after the cwd", () => {
    expect(cmdSlug("/home/daigou/Projects/herdr-web-ui")).toBe("home-daigou-projects-herdr-web-ui");
    expect(cmdSlug("/home/daigou/Projects/Yaba-Definitive")).toBe("home-daigou-projects-yaba-definitive");
  });

  it("accepts a session file inside the store", () => {
    const path = session("inside");
    expect(cmdTranscriptInStore(path, project)).toBe(path);
  });

  it("refuses paths that leave the store", () => {
    const outside = join(root, "elsewhere.jsonl");
    writeFileSync(outside, "{}\n");
    expect(cmdTranscriptInStore(outside, project)).toBeNull();
    expect(cmdTranscriptInStore(join(project, "..", "elsewhere.jsonl"), project)).toBeNull();
    expect(cmdTranscriptInStore(project, project)).toBeNull();
    expect(cmdTranscriptInStore(join(root, "missing.jsonl"), project)).toBeNull();
  });

  it.skipIf(!canSymlink)("refuses a link out of the store", () => {
    const outside = join(root, "target.jsonl");
    writeFileSync(outside, "{}\n");
    const link = join(project, "link.jsonl");
    symlinkSync(outside, link);
    expect(cmdTranscriptInStore(link, project)).toBeNull();
  });

  it("refuses a directory and a file that is not jsonl", () => {
    mkdirSync(join(project, "dir.jsonl"), { recursive: true });
    expect(cmdTranscriptInStore(join(project, "dir.jsonl"), project)).toBeNull();
    writeFileSync(join(project, "notes.txt"), "{}\n");
    expect(cmdTranscriptInStore(join(project, "notes.txt"), project)).toBeNull();
  });

  it("names a session Command Code has not written yet only when its path is in the store", () => {
    expect(unwrittenSession(join(project, "fresh.jsonl"), project)).toEqual({ id: "fresh", path: join(project, "fresh.jsonl") });
    expect(unwrittenSession(session("written"), project)).toBeNull();
    expect(unwrittenSession(join(root, "missing.jsonl"), project)).toBeNull();
    expect(unwrittenSession(join(project, "fresh.txt"), project)).toBeNull();
  });
});

// Command Code's own record shapes: a prompt, an assistant turn whose thinking and prose sit
// side by side, and the camelCase usage it records.
const conversation = [
  { type: "message", id: "u1", parentId: null, timestamp: "2026-10-19T00:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "fix the crash" }] } },
  { type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-19T00:00:03.000Z", message: {
    role: "assistant", model: "stealth/cat-jam:free", stopReason: "stop",
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 0, costUsd: 0 },
    content: [
      { type: "thinking", thinking: "the null check is missing" },
      { type: "text", text: "Guarded. The crash came from a null export." },
    ],
  } },
];

describe("Command Code transcripts render as chat", () => {
  it("reads prompts, thinking and the answer", () => {
    const page = transcriptPage("cmd-transcript", session("readable", conversation));
    expect(page.source).toBe("cmd-transcript");
    expect(page.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(page.turns[1]?.parts.some((part) => part.kind === "thinking")).toBe(true);
  });
});

describe("Command Code's context window comes from its catalog", () => {
  it("reads the window the catalog states and nothing else", () => {
    const catalog = join(root, "commandcode-models.json");
    writeFileSync(catalog, JSON.stringify({ version: 2, models: [
      { id: "stealth/cat-jam:free", contextWindow: 1048576 },
      { id: "no-window", contextWindow: 0 },
      { id: "text-window", contextWindow: "many" },
    ] }));
    expect(cmdContextWindow("stealth/cat-jam:free", catalog)).toBe(1048576);
    expect(cmdContextWindow("no-window", catalog)).toBeNull();
    expect(cmdContextWindow("text-window", catalog)).toBeNull();
    expect(cmdContextWindow("absent", catalog)).toBeNull();
    expect(cmdContextWindow("stealth/cat-jam:free", join(root, "missing.json"))).toBeNull();
  });
});

// The permission prompt, as Command Code's TUI draws it.
const permission = [
  "Create File",
  "",
  "Do you want to create hello.txt?",
  "",
  "❯ 1. Yes",
  "  2. Yes, allow all edits this session [shift+tab]",
  "  3. No, tell Command Code what to do differently",
  "",
  "↑/↓ navigate · enter select · ctrl+e explain · Run cmd --yolo to",
  "bypass all permissions (Docs ↗)",
].join("\n");

describe("Command Code's permission prompt is a card", () => {
  it("reads the heading, the question and the three options", () => {
    const prompt = parseInteractivePrompt("cmd", permission);
    expect(prompt?.title).toBe("Create File");
    expect(prompt?.question).toBe("Do you want to create hello.txt?");
    expect(prompt?.options.map((option) => option.label)).toEqual([
      "Yes",
      "Yes, allow all edits this session [shift+tab]",
      "No, tell Command Code what to do differently",
    ]);
  });

  it("takes no option from a numbered list above the dialog", () => {
    const screen = ["1. an earlier list", "2. of the agent's own", "", ...permission.split("\n")].join("\n");
    expect(parseInteractivePrompt("cmd", screen)?.options.map((option) => option.label)).toEqual([
      "Yes",
      "Yes, allow all edits this session [shift+tab]",
      "No, tell Command Code what to do differently",
    ]);
  });

  it("offers nothing when the cursor is not marked on exactly one row", () => {
    const screen = permission.replace("❯ 1. Yes", "  1. Yes");
    expect(parseInteractivePrompt("cmd", screen)).toBeNull();
  });

  it("offers nothing when the footer is gone", () => {
    const screen = permission.split("\n").slice(0, -2).join("\n");
    expect(parseInteractivePrompt("cmd", screen)).toBeNull();
  });

  it("makes the card stale when the command it asks about changes", () => {
    const footer = permission.split("\n").slice(-2);
    const run = (command: string) => ["Run Command", "", command, "", "Do you want to run this command?", "", "\u276f 1. Yes", "  2. Yes, and don't ask again", "  3. No, tell Command Code what to do differently", "", ...footer].join("\n");
    const harmless = parseInteractivePrompt("cmd", run("printf harmless | head -5"));
    const replaced = parseInteractivePrompt("cmd", run("delete-important-files | head -5"));
    expect(harmless?.body).toContain("printf harmless | head -5");
    expect(replaced?.id).toBeString();
    expect(replaced?.id).not.toBe(harmless?.id);
    // a command of several lines: the lines above its last one are no title and no body
    const multi = (first: string) => parseInteractivePrompt("cmd", run(`${first}\nrm -rf build`))?.id;
    expect(multi("cd /tmp/scratch &&")).toBeString();
    expect(multi("cd / &&")).not.toBe(multi("cd /tmp/scratch &&"));
    // two heredocs that end alike
    const heredoc = (line: string) => parseInteractivePrompt("cmd", run(`cat > notes.txt <<EOF\n${line}\nEOF`))?.id;
    expect(heredoc("keep this")).not.toBe(heredoc("replace that"));
    // a rule inside a heredoc is no dialog border, and a heredoc's indentation is part of the command
    const ruled = (first: string) => parseInteractivePrompt("cmd", run(`${first}\ncat <<'EOF'\n${"\u2500".repeat(16)}\nEOF\nprintf done`))?.id;
    expect(ruled("printf harmless")).not.toBe(ruled("rm -rf important-files"));
    const indented = (delimiter: string) => parseInteractivePrompt("cmd", run(`cat <<'EOF'\n${delimiter}\nrm -rf important-files\n: <<'EOF'\nEOF\nprintf done`))?.id;
    expect(indented("  EOF")).not.toBe(indented("EOF"));
  });

  it("takes no dialog for a live one when a line typed below follows its footer", () => {
    expect(parseInteractivePrompt("cmd", `${permission}\n\n\u276f my next message`)).toBeNull();
    expect(parseInteractivePrompt("cmd", `${permission}\nsomething the agent printed`)).toBeNull();
  });

  it("still reads the footer wrapped over three lines on a narrow pane", () => {
    const narrow = [...permission.split("\n").slice(0, -2), "\u2191/\u2193 navigate \u00b7 enter select \u00b7 ctrl+e", "explain \u00b7 Run cmd --yolo to bypass all", "permissions (Docs \u2197)"].join("\n");
    expect(parseInteractivePrompt("cmd", narrow)?.title).toBe("Create File");
  });
});

// A FIFO where the catalog is expected must not block the server: read in a child with a deadline,
// since a blocking read would hang this process itself.
it.skipIf(process.platform === "win32")("reads no window from a FIFO in the catalog's place", () => {
  const fifo = join(root, "catalog-fifo.json");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  const script = `const { cmdContextWindow } = await import(${JSON.stringify(join(import.meta.dir, "cmd.ts"))}); console.log(JSON.stringify(cmdContextWindow("m", ${JSON.stringify(fifo)})));`;
  const child = Bun.spawnSync([process.execPath, "-e", script], { timeout: 5_000, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString().trim()).toBe("null");
});
