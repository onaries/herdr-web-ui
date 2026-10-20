import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { answerKeys, parseInteractivePrompt } from "../prompt.ts";
import { registry } from "./registry.ts";
import { KEY } from "./shared.ts";

// Screens of omp 18.8.7's /handoff, recorded in an isolated omp home at 119 and 60 columns.
const screen = (step: string, width: "wide" | "narrow") =>
  readFileSync(new URL(`../fixtures/omp-handoff-18.8.7-${step}-${width}.txt`, import.meta.url), "utf8");
const widths = ["wide", "narrow"] as const;

describe("omp /handoff", () => {
  it("reads the generating status, with and without focus instructions, as a card that cancels with Esc", () => {
    for (const width of widths) {
      for (const step of ["generating", "generating-args"]) {
        const prompt = parseInteractivePrompt("omp", screen(step, width));
        expect(prompt, `${step} ${width}`).toMatchObject({
          agent: "omp", kind: "menu", question: "Generating handoff…", options: [{ label: "Cancel", description: null }],
          multi_select: false, custom_option_index: null,
        });
        expect(answerKeys(prompt!, { option_index: 0 })).toEqual([{ keys: [KEY.escape] }]);
      }
    }
  });

  it("is answered by the omp-handoff reader, which reads the screen again before Esc", () => {
    const reader = registry.readerFor("omp-handoff");
    expect(reader?.reread).toBe("before-commit");
    expect(reader?.parse(screen("generating", "wide"), { agent: "omp", omoAsk: null, omoTrusted: true, omoOpen: [], sent: null, working: false })?.responder).toBe("omp-handoff");
  });

  it("keeps one card while the spinner turns", () => {
    const shown = screen("generating", "wide");
    const turned = shown.replace("⠙ Generating", "⠹ Generating");
    expect(turned).not.toBe(shown);
    expect(parseInteractivePrompt("omp", turned)).not.toBeNull();
    expect(parseInteractivePrompt("omp", turned)?.id).toBe(parseInteractivePrompt("omp", shown)?.id);
  });

  it("shows no card before, after or without a handoff being written", () => {
    for (const width of widths) {
      for (const step of ["empty", "cancelled", "done"]) expect(parseInteractivePrompt("omp", screen(step, width)), `${step} ${width}`).toBeNull();
    }
  });

  it("ignores the status line once anything but omp's status bar and editor follows it", () => {
    const shown = screen("generating", "wide");
    const moved = shown.replace(/(Generating handoff… \(⎋ to cancel\)\n)/, "$1 Fixture answer for the handoff recording.\n");
    expect(moved).not.toBe(shown);
    expect(parseInteractivePrompt("omp", moved)).toBeNull();
  });
});
