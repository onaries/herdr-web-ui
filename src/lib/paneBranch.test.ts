import { expect, it } from "bun:test";

import { branchWords, DETACHED, publishBranches, publishedBranch } from "./paneBranch.ts";
import type { WorkspaceBranch } from "./worktreeBranches.ts";

const branch = (name: string | null, isDetached = false): WorkspaceBranch => ({ checkoutPath: "/repo", branch: name, isDetached });

it("says a checkout's branch, a detached head as such, and nothing where neither is known", () => {
  const words = branchWords(new Map([["w1", branch("fix/first-chat")], ["w2", branch(null, true)], ["w3", branch(null)], ["w4", branch("  ")]]));
  expect([...words]).toEqual([["w1", "fix/first-chat"], ["w2", DETACHED]]);
});

it("keeps each PC's branches apart and forgets a PC whose roster left the screen", () => {
  publishBranches("pc-branch-a", new Map([["w1", branch("main")]]));
  publishBranches("pc-branch-b", new Map([["w1", branch("feature/x")]]));
  expect(publishedBranch("pc-branch-a", "w1")).toBe("main");
  expect(publishedBranch("pc-branch-b", "w1")).toBe("feature/x");
  expect(publishedBranch("pc-branch-a", "w2")).toBeNull();
  expect(publishedBranch("pc-branch-a", null)).toBeNull();
  publishBranches("pc-branch-a", null);
  expect(publishedBranch("pc-branch-a", "w1")).toBeNull();
  expect(publishedBranch("pc-branch-b", "w1")).toBe("feature/x");
  publishBranches("pc-branch-b", null);
});
