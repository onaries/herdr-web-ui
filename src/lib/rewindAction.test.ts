import { describe, expect, it } from "bun:test";
import { rewindOffer, type RewindContext } from "./rewindAction.ts";

/** A Claude Code pane waiting with an empty message box, on a connection that may type into it. */
const ready: RewindContext = { agent: "claude", interactive: true, connected: true, ended: false, conversation: true, agentStatus: "idle", promptUp: false, draft: "", sending: false, pending: false };

describe("what a user message offers to go back to it", () => {
  it("offers Claude Code's rewind card only while nothing could be lost or typed over", () => {
    expect(rewindOffer(ready)).toBe("card");
    expect(rewindOffer({ ...ready, agentStatus: "done" })).toBe("card");
    // a draft would be lost under the restore; a send, a card or another rewind is on its way
    for (const blocked of [{ draft: "half a thought" }, { sending: true }, { promptUp: true }, { pending: true }, { agentStatus: "working" }, { agentStatus: "blocked" }]) {
      expect(rewindOffer({ ...ready, ...blocked })).toBeNull();
    }
    // a watching or lost connection, an ended pane, or a chat read from the screen offers nothing
    for (const gone of [{ interactive: false }, { connected: false }, { ended: true }, { conversation: false }]) expect(rewindOffer({ ...ready, ...gone })).toBeNull();
  });

  it("offers grok and agy only the terminal, whatever their box or state, since nothing is typed there", () => {
    for (const agent of ["grok", "agy"]) {
      expect(rewindOffer({ ...ready, agent })).toBe("terminal");
      expect(rewindOffer({ ...ready, agent, draft: "half a thought", agentStatus: "working", promptUp: true })).toBe("terminal");
      expect(rewindOffer({ ...ready, agent, interactive: false })).toBeNull();
    }
  });

  it("offers nothing for an agent without a rewind", () => {
    for (const agent of ["codex", "omp", "opencode", null]) expect(rewindOffer({ ...ready, agent })).toBeNull();
  });
});
