import { describe, expect, it } from "bun:test";
import { rewindOffer, type RewindContext } from "./rewindAction.ts";

const ready: RewindContext = { agent: "claude", interactive: true, connected: true, ended: false, conversation: true };

describe("a user message's terminal rewind action", () => {
  it("opens only the terminal for every supported agent", () => {
    for (const agent of ["claude", "grok", "agy"]) expect(rewindOffer({ ...ready, agent })).toBe("terminal");
  });

  it("offers nothing when the connection or native conversation is unavailable", () => {
    for (const agent of ["claude", "grok", "agy"]) {
      for (const unavailable of [{ interactive: false }, { connected: false }, { ended: true }, { conversation: false }]) {
        expect(rewindOffer({ ...ready, agent, ...unavailable })).toBeNull();
      }
    }
  });

  it("offers nothing for an agent without a rewind", () => {
    for (const agent of ["codex", "omp", "opencode", null]) expect(rewindOffer({ ...ready, agent })).toBeNull();
  });
});
