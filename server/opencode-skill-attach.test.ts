import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { OPENCODE_SKILL_ACCEPT_KEY, OPENCODE_SKILL_ROW_WAIT_MS, skillAccepted, skillRowSelected, skillTokens, typeWithSkills, type SkillAttachIo } from "./opencode-skill-attach.ts";

const fixture = (width: "narrow" | "wide") => readFileSync(join(import.meta.dir, "fixtures", `opencode-autocomplete-2.0.32-skill-${width}.txt`), "utf8");
/** OpenCode 2.0.32 recorded with its colours: three rows (@effect, @effect-two, effect.ts) with one selected, then accepted or closed */
const ansi = (name: "first-selected" | "second-selected" | "third-selected" | "accepted" | "closed") => readFileSync(join(import.meta.dir, "fixtures", `opencode-autocomplete-2.0.32-ansi-${name}.ansi`), "utf8");
const AGENT = "                      ┃  Build · MiniMax M3.1 Flash Free OpenCode";
/** the recorded accept, for the second skill row instead */
const acceptedTwo = () => ansi("accepted").replace("@effect", "@effect-two");
/** a recorded box with `@effect-two` typed in the input row (the rows as recorded) */
const typedTwo = (screen: string) => screen.split("\n").map((line) => /┃ {2}@effect$/u.test(line.replace(/\u001b\[[0-9;:]*m/gu, "").trimEnd()) ? line.replace("@effect", "@effect-two") : line).join("\n");
/** a pane whose screen is the n-th read's; writes are logged as before */
function reads(screens: (read: number, writes: string[]) => string): SkillAttachIo & { writes: string[] } {
  let read = 0;
  return pane((writes) => screens(read++, writes));
}

/** A scripted pane: what each write did, and the screen it shows next; time moves only when waited on. */
function pane(screens: (writes: string[]) => string): SkillAttachIo & { writes: string[] } {
  const writes: string[] = [];
  let clock = 0;
  return {
    writes,
    sendText: async (text) => { writes.push(`text:${text}`); },
    sendKeys: async (keys) => { writes.push(`keys:${keys.join(",")}`); },
    screen: async () => screens(writes),
    wait: async (ms) => { clock += ms; },
    now: () => clock,
  };
}

describe("skillRowSelected", () => {
  it.each(["narrow", "wide"] as const)("finds no selection in the recorded %s box of three rows without its colours", (width) => {
    // the first row is not assumed selected: the selection is drawn only in colour
    expect(skillRowSelected(fixture(width), "effect")).toBe(false);
  });

  it("reads the selected row from the recorded screen's colours", () => {
    expect([skillRowSelected(ansi("first-selected"), "effect"), skillRowSelected(ansi("first-selected"), "effect-two")]).toEqual([true, false]);
    expect([skillRowSelected(ansi("second-selected"), "effect"), skillRowSelected(typedTwo(ansi("second-selected")), "effect-two")]).toEqual([false, true]);
    // the file row is selected: neither skill is
    expect([skillRowSelected(ansi("third-selected"), "effect"), skillRowSelected(typedTwo(ansi("third-selected")), "effect-two")]).toEqual([false, false]);
    expect(skillRowSelected(ansi("closed"), "effect")).toBe(false);
  });

  it("reads the selection and the accept the same way in the narrow (40x24) recording", () => {
    const narrow = (name: string) => readFileSync(join(import.meta.dir, "fixtures", `opencode-autocomplete-2.0.32-ansi-narrow-${name}.ansi`), "utf8");
    expect([skillRowSelected(narrow("first-selected"), "effect"), skillRowSelected(narrow("second-selected"), "effect"), skillRowSelected(narrow("third-selected"), "effect")]).toEqual([true, false, false]);
    expect(skillAccepted(narrow("accepted"), "effect", " ┃ MiniMax M3.1 Flash Free")).toBe(true);
    expect(skillAccepted(narrow("closed"), "effect", " ┃ MiniMax M3.1 Flash Free")).toBe(false);
  });

  it("takes a box of a single skill row as selected, with or without colours", () => {
    const single = ansi("first-selected").split("\n").filter((line) => !/@effect-two|effect\.ts/u.test(line.replace(/\u001b\[[0-9;:]*m/gu, ""))).join("\n");
    expect(skillRowSelected(single, "effect")).toBe(true);
    expect(skillRowSelected(single.replace(/\u001b\[[0-9;:]*m/gu, ""), "effect")).toBe(true);
  });

  it.each(["narrow", "wide"] as const)("refuses another id, a prefix, and a box whose first row is another option (%s)", (width) => {
    const screen = fixture(width);
    expect(skillRowSelected(screen, "eff")).toBe(false);
    expect(skillRowSelected(screen, "later")).toBe(false);
    const lines = screen.split("\n");
    const first = lines.findIndex((line) => line.includes("┃ @effect "));
    const second = lines[first + 1]!;
    const swapped = [...lines.slice(0, first), second, lines[first]!, ...lines.slice(first + 2)].join("\n");
    expect(skillRowSelected(swapped, "effect")).toBe(false);
  });

  const mutate = (width: "narrow" | "wide", edit: (lines: string[], row: number) => void): string => {
    const lines = fixture(width).split("\n");
    const row = lines.findIndex((line) => line.includes("┃ @effect "));
    edit(lines, row);
    return lines.join("\n");
  };

  it.each(["narrow", "wide"] as const)("refuses a row of another kind with the same @id (%s)", (width) => {
    // the recorded row ends in the kind label "skill"; a file or agent row names no such kind
    expect(skillRowSelected(mutate(width, (lines, row) => { lines[row] = lines[row]!.replace(/skill ┃/u, " file ┃"); }), "effect")).toBe(false);
    expect(skillRowSelected(mutate(width, (lines, row) => { lines[row] = lines[row]!.replace(/@effect .* ┃$/u, (match) => `${"@effect file".padEnd(match.length - 2)} ┃`); }), "effect")).toBe(false);
  });

  it.each(["narrow", "wide"] as const)("refuses a box whose rows do not share its right border (%s)", (width) => {
    expect(skillRowSelected(mutate(width, (lines, row) => { lines[row + 1] = `${lines[row + 1]!.trimEnd().slice(0, -1).trimEnd()} ┃`; }), "effect")).toBe(false);
  });

  it.each(["narrow", "wide"] as const)("refuses the box without the recorded input area under it (%s)", (width) => {
    // no blank border line between the box and the input row
    expect(skillRowSelected(mutate(width, (lines, row) => { lines.splice(row + 3, 1); }), "effect")).toBe(false);
    // no prompt bottom edge under the input area
    expect(skillRowSelected(mutate(width, (lines) => { for (const [index, line] of lines.entries()) if (line.includes("╹")) lines[index] = ""; }), "effect")).toBe(false);
  });

  it.each(["narrow", "wide"] as const)("refuses a prompt bottom that is not the recorded full-width border (%s)", (width) => {
    expect(skillRowSelected(mutate(width, (lines) => {
      const at = lines.findIndex((line) => line.includes("╹▀"));
      lines[at] = `${lines[at]!.slice(0, lines[at]!.indexOf("╹"))}╹▀`;
    }), "effect")).toBe(false);
  });

  it("refuses a two-line layout that only looks like a box and an input row", () => {
    expect(skillRowSelected("┃ @effect Apply  skill ┃\n┃ @effect", "effect")).toBe(false);
    expect(skillRowSelected("┃ @effect file ┃\n┃\n┃ @effect\n┃\n┃ x\n╹▀▀▀▀", "effect")).toBe(false);
  });

  it("refuses the screen once the box has closed", () => {
    const closed = fixture("wide").split("\n").filter((line) => !/┃.*┃$/u.test(line.trimEnd())).join("\n");
    expect(skillRowSelected(closed, "effect")).toBe(false);
  });
});

describe("skillAccepted", () => {
  it("sees an attached skill only as the recorded accept draws it", () => {
    expect(skillAccepted(ansi("accepted"), "effect", AGENT)).toBe(true);
    // a plain typed @effect after the attached one: the last token is not attached
    expect(skillAccepted(ansi("closed"), "effect", AGENT)).toBe(false);
    // the box still open, or the key switched the agent
    expect(skillAccepted(ansi("first-selected"), "effect", AGENT)).toBe(false);
    expect(skillAccepted(ansi("accepted").replace("Build", "Plan "), "effect", AGENT)).toBe(false);
  });

  it("finds the attached token after an emoji, which is one cell but two UTF-16 units", () => {
    const bold = "\u001b[1m\u001b[38;2;157;124;216m\u001b[48;2;30;30;30m@effect";
    expect(ansi("accepted").includes(bold)).toBe(true);
    expect(skillAccepted(ansi("accepted").replace(bold, `😀 ${bold}`), "effect", AGENT)).toBe(true);
  });
});

describe("skillTokens", () => {
  it("keeps only known skill ids, in order and once", () => {
    expect(skillTokens("@effect apply it @other and @effect again, mail@effect", ["effect", "review"])).toEqual(["effect"]);
    expect(skillTokens("@review then @effect", ["effect", "review"])).toEqual(["review", "effect"]);
  });
});

describe("typeWithSkills", () => {
  it("types the token, accepts its recognized row with the recorded key, then types the rest once", async () => {
    const io = pane((writes) => writes.at(-1) === "text:@effect" ? ansi("first-selected") : writes.at(-1) === `keys:${OPENCODE_SKILL_ACCEPT_KEY}` ? ansi("accepted") : "");
    expect(await typeWithSkills("@effect apply it", ["effect"], () => true, io, async () => {})).toEqual({ attached: ["effect"], missed: [], prompt: [{ typed: "@effect " }, { pasted: "apply it" }] });
    // the accepted row inserts its own space
    expect(io.writes).toEqual(["text:@effect", `keys:${OPENCODE_SKILL_ACCEPT_KEY}`, "text:\u001b[200~apply it\u001b[201~"]);
  });

  it("leaves an unrecognized token as plain text after the wait, closing the box with the text's own space", async () => {
    const io = pane(() => "");
    expect(await typeWithSkills("please @effect apply it", ["effect"], () => true, io, async () => {})).toEqual({ attached: [], missed: ["effect"], prompt: [{ pasted: "please " }, { typed: "@effect" }, { pasted: " apply it" }] });
    expect(io.writes).toEqual(["text:\u001b[200~please \u001b[201~", "text:@effect", "text:\u001b[200~ apply it\u001b[201~"]);
    expect(io.now()).toBeGreaterThanOrEqual(OPENCODE_SKILL_ROW_WAIT_MS);
  });

  it("closes a trailing @file mention after an attached skill with a space, as the paste path does", async () => {
    const io = pane((writes) => writes.at(-1) === "text:@effect" ? ansi("first-selected") : writes.at(-1) === `keys:${OPENCODE_SKILL_ACCEPT_KEY}` ? ansi("accepted") : "");
    const { prompt } = await typeWithSkills("@effect see @src/app.ts", ["effect"], () => true, io, async () => {});
    expect(io.writes.at(-1)).toBe("text:\u001b[200~see @src/app.ts \u001b[201~");
    expect(prompt.at(-1)).toEqual({ pasted: "see @src/app.ts " });
  });

  it("adds a space after a trailing unrecognized token, so Enter cannot take the box", async () => {
    const io = pane(() => "");
    await typeWithSkills("run @effect", ["effect"], () => true, io, async () => {});
    expect(io.writes.at(-1)).toBe("text: ");
  });

  it("sends no key when the box closed between recognising the row and the key, and the skill goes as plain text", async () => {
    const io = reads((read) => read === 0 ? ansi("first-selected") : ansi("closed"));
    expect(await typeWithSkills("@effect apply it", ["effect"], () => true, io, async () => {})).toMatchObject({ attached: [], missed: ["effect"] });
    expect(io.writes).not.toContain(`keys:${OPENCODE_SKILL_ACCEPT_KEY}`);
  });

  it("sends no key when another row became selected before the key", async () => {
    const io = reads((read) => read === 0 ? ansi("first-selected") : ansi("second-selected"));
    expect(await typeWithSkills("@effect apply it", ["effect"], () => true, io, async () => {})).toMatchObject({ attached: [], missed: ["effect"] });
    expect(io.writes).not.toContain(`keys:${OPENCODE_SKILL_ACCEPT_KEY}`);
  });

  it("accepts a selected skill row that is not the first, and records it from the screen after the key", async () => {
    const io = pane((writes) => writes.at(-1) === "text:@effect-two" ? typedTwo(ansi("second-selected")) : writes.at(-1) === `keys:${OPENCODE_SKILL_ACCEPT_KEY}` ? acceptedTwo() : "");
    expect(await typeWithSkills("@effect-two go", ["effect-two"], () => true, io, async () => {})).toMatchObject({ attached: ["effect-two"], missed: [] });
    expect(io.writes).toContain(`keys:${OPENCODE_SKILL_ACCEPT_KEY}`);
  });

  it("records a skill as not attached when the screen after the key does not show it attached", async () => {
    // the key switched Build to Plan instead
    const io = pane((writes) => writes.at(-1) === "text:@effect" ? ansi("first-selected") : writes.at(-1) === `keys:${OPENCODE_SKILL_ACCEPT_KEY}` ? ansi("accepted").replace("Build", "Plan ") : "");
    expect(await typeWithSkills("@effect apply it", ["effect"], () => true, io, async () => {})).toMatchObject({ attached: [], missed: ["effect"] });
  });

  it("re-checks before every write, and stops typing at the first refused check", async () => {
    const io = pane((writes) => writes.at(-1) === "text:@effect" ? ansi("first-selected") : "");
    let checks = 0;
    const revalidate = async () => { if (++checks === 2) throw Object.assign(new Error("changed"), { code: "pending_target_changed" }); };
    await expect(typeWithSkills("@effect apply it", ["effect"], () => true, io, revalidate)).rejects.toMatchObject({ code: "pending_target_changed" });
    expect(io.writes).toEqual(["text:@effect"]);
  });

  it("types nothing when the first check refuses", async () => {
    const io = pane(() => fixture("wide"));
    await expect(typeWithSkills("please @effect", ["effect"], () => true, io, async () => { throw new Error("session changed"); })).rejects.toThrow("session changed");
    expect(io.writes).toEqual([]);
  });

  it("writes nothing once the sender may no longer type", async () => {
    const io = pane(() => fixture("wide"));
    await expect(typeWithSkills("@effect apply it", ["effect"], () => false, io, async () => {})).rejects.toMatchObject({ code: "cancelled" });
    expect(io.writes).toEqual([]);
  });
});
