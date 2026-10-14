import { expect, test } from "bun:test";

import { isMouseReport, sameAttachment } from "./input-guard.ts";

const attach = (...members: string[]) => ({ clients: new Set(members) });

test("typing taken with no attach is refused once someone attaches meanwhile", () => {
  expect(sameAttachment(undefined, undefined, "a")).toBe(true);
  expect(sameAttachment(undefined, attach("b"), "a")).toBe(false);
  // attaching yourself meanwhile is a new attach too: what was typed before it takes none of it
  expect(sameAttachment(undefined, attach("a"), "a")).toBe(false);
});

test("a click or a wheel is told from typing, so a queued one keeps the attach input path", () => {
  expect(isMouseReport("\x1b[<0;5;3M")).toBe(true);
  expect(isMouseReport("\x1b[<0;5;3M\x1b[<0;5;3m")).toBe(true);
  expect(isMouseReport("\x1b[<65;120;40M")).toBe(true);
  // the default encoding: CSI M and three bytes, a byte may be any character
  expect(isMouseReport("\x1b[M #!")).toBe(true);
  expect(isMouseReport("\x1b[M\x60;;\x1b[M\x61;;")).toBe(true);
  // typing, keys and a report mixed with typing are not mouse reports
  for (const text of ["", "a", "\x1b[A", "\x1b[<0;5;3", "\x1b[<0;5;3Mx", "x\x1b[<0;5;3M", "\x1b[M #", "\x1b[1;5A"]) {
    expect(isMouseReport(text)).toBe(false);
  }
});

test("typing taken into an attach goes only into that attach, while it still has the typist", () => {
  const origin = attach("a");
  expect(sameAttachment(origin, origin, "a")).toBe(true);
  expect(sameAttachment(origin, undefined, "a")).toBe(false);
  expect(sameAttachment(origin, attach("a"), "a")).toBe(false);
  origin.clients.delete("a");
  expect(sameAttachment(origin, origin, "a")).toBe(false);
});
