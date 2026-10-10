import { expect, test } from "bun:test";

import { sameAttachment } from "./input-guard.ts";

const attach = (...members: string[]) => ({ clients: new Set(members) });

test("typing taken with no attach is refused once someone attaches meanwhile", () => {
  expect(sameAttachment(undefined, undefined, "a")).toBe(true);
  expect(sameAttachment(undefined, attach("b"), "a")).toBe(false);
  // attaching yourself meanwhile is a new attach too: what was typed before it takes none of it
  expect(sameAttachment(undefined, attach("a"), "a")).toBe(false);
});

test("typing taken into an attach goes only into that attach, while it still has the typist", () => {
  const origin = attach("a");
  expect(sameAttachment(origin, origin, "a")).toBe(true);
  expect(sameAttachment(origin, undefined, "a")).toBe(false);
  expect(sameAttachment(origin, attach("a"), "a")).toBe(false);
  origin.clients.delete("a");
  expect(sameAttachment(origin, origin, "a")).toBe(false);
});
