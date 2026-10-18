import { expect, it } from "bun:test";

import { launchAgent, launchArgs } from "./agentLaunchMode.ts";

const plain = { claudeLaunchMode: "default", codexLaunchMode: "default" } as const;

it("adds nothing while both modes follow the agent's own configuration", () => {
  expect(launchArgs("claude", plain)).toBeUndefined();
  expect(launchArgs("codex", plain)).toBeUndefined();
  expect(launchAgent("claude", plain)).toEqual({ kind: "claude" });
});

it("starts Claude Code with its permission mode", () => {
  expect(launchArgs("claude", { ...plain, claudeLaunchMode: "plan" })).toEqual(["--permission-mode", "plan"]);
  expect(launchAgent("claude", { ...plain, claudeLaunchMode: "bypassPermissions" })).toEqual({ kind: "claude", args: ["--permission-mode", "bypassPermissions"] });
});

it("starts Codex with a sandbox and an approval policy together", () => {
  expect(launchArgs("codex", { ...plain, codexLaunchMode: "readOnly" })).toEqual(["--sandbox", "read-only", "--ask-for-approval", "on-request"]);
  expect(launchArgs("codex", { ...plain, codexLaunchMode: "auto" })).toEqual(["--sandbox", "workspace-write", "--ask-for-approval", "on-request"]);
  expect(launchArgs("codex", { ...plain, codexLaunchMode: "fullAccess" })).toEqual(["--sandbox", "danger-full-access", "--ask-for-approval", "never"]);
});

it("leaves other agents and a plain shell alone", () => {
  const set = { claudeLaunchMode: "plan", codexLaunchMode: "fullAccess" } as const;
  expect(launchArgs("omp", set)).toBeUndefined();
  expect(launchAgent("gemini", set)).toEqual({ kind: "gemini" });
  expect(launchAgent("", set)).toBeNull();
});
