import { describe, expect, it } from "bun:test";

import { defaultLens, PaneLenses } from "./paneLens.ts";

describe("defaultLens", () => {
  it("follows Settings: chat for an agent (or one not known yet), the terminal for a shell", () => {
    expect(defaultLens(true, "chat", false)).toBe("chat");
    expect(defaultLens(null, "chat", false)).toBe("chat");
    expect(defaultLens(false, "chat", false)).toBe("terminal");
    expect(defaultLens(true, "terminal", true)).toBe("terminal");
    expect(defaultLens(true, "auto", false)).toBe("terminal");
    expect(defaultLens(true, "auto", true)).toBe("chat");
    expect(defaultLens(false, "auto", true)).toBe("terminal");
  });
});

describe("PaneLenses", () => {
  it("keeps a shell's terminal when an agent starts in it, with the default view on chat", () => {
    const lenses = new PaneLenses("chat");
    expect(lenses.of("local/w1:p2", false, false)).toBe("terminal");
    // claude started in the split's shell: the pane in use stays on its terminal
    expect(lenses.of("local/w1:p2", true, false)).toBe("terminal");
  });

  it("keeps an agent pane's chat when its agent exits", () => {
    const lenses = new PaneLenses("chat");
    expect(lenses.of("local/w1:p1", true, false)).toBe("chat");
    expect(lenses.of("local/w1:p1", false, false)).toBe("chat");
  });

  it("settles nothing while the snapshot does not know the pane yet", () => {
    const lenses = new PaneLenses("chat");
    expect(lenses.of("local/w1:p3", null, false)).toBe("chat");
    expect(lenses.of("local/w1:p3", false, false)).toBe("terminal");
    expect(lenses.of("local/w1:p3", true, false)).toBe("terminal");
  });

  it("gives a pane this page started an agent in an agent's lens, even if a snapshot first shows its shell", () => {
    const lenses = new PaneLenses("chat");
    lenses.startedAgent("local/w2:p1", false);
    expect(lenses.of("local/w2:p1", false, false)).toBe("chat");
  });

  it("keeps a moved pane's lens under the new id herdr gives it", () => {
    const lenses = new PaneLenses("chat");
    expect(lenses.of("local/w1:p2", false, false)).toBe("terminal");
    lenses.move("local/w1:p2", "local/w2:p1");
    expect(lenses.of("local/w2:p1", true, false)).toBe("terminal");
  });

  it("keeps each pane apart", () => {
    const lenses = new PaneLenses("chat");
    expect(lenses.of("local/w1:p1", true, false)).toBe("chat");
    expect(lenses.of("remote/w1:p1", false, false)).toBe("terminal");
  });
});
