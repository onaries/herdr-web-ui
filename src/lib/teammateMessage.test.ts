import { describe, expect, it } from "bun:test";
import { teammateMessageParts } from "./teammateMessage.ts";

const envelope = (body: string, attrs = 'teammate_id="reviewer" color="pink"') => `<teammate-message ${attrs}>\n${body}\n</teammate-message>`;

describe("Claude teammate message display", () => {
  it("decodes an idle report without claiming task success or losing escaped Markdown", () => {
    const result = '**Findings**\n- `src/a.ts`\n- quoted "value"\n[result truncated — ask the agent for the rest via SendMessage]';
    const text = `Another Claude session sent a message:\n${envelope(JSON.stringify({ type: "idle_notification", from: "reviewer", timestamp: "2026-10-16T11:27:34.293Z", idleReason: "available", result }))}`;
    const parts = teammateMessageParts(text);
    expect(parts).toEqual([{ kind: "teammate", name: "reviewer", status: "idle", summary: "**Findings**", text: result, raw: text }]);
  });

  it("keeps separate agents and human follow-up text in order", () => {
    const parts = teammateMessageParts(`${envelope("**One**")}\n\n${envelope("Two", 'summary="A &quot;quoted&quot; &amp; useful report" teammate_id="other"')}\n\nPlease compare both reports.`);
    expect(parts?.map((part) => part.kind === "teammate" ? [part.name, part.text, part.summary] : part.text)).toEqual([
      ["reviewer", "**One**", "**One**"], ["other", "Two", 'A "quoted" & useful report'], "Please compare both reports.",
    ]);
  });

  it("shows an idle notification with no result as idle, not an empty human prompt", () => {
    expect(teammateMessageParts(envelope('{"type":"idle_notification","from":"reviewer","idleReason":"available"}'))?.[0]).toMatchObject({ kind: "teammate", status: "idle", text: "" });
  });

  it("preserves malformed, unknown and mismatched JSON payloads", () => {
    for (const body of ['{"type":"idle_notification",', '{"type":"future_event","result":"keep","other":42}', '{"type":"idle_notification","from":"someone-else","result":"keep"}', '{"type":"idle_notification","from":"reviewer","result":42}', '{"type":"idle_notification","from":"reviewer","idleReason":"blocked","result":"keep"}', '{"type":"idle_notification","from":"reviewer","result":"keep","unknown":true}']) {
      expect(teammateMessageParts(envelope(body))?.[0]).toMatchObject({ kind: "teammate", text: body });
    }
  });

  it("leaves ordinary prompts, quoted examples, incomplete and ambiguous envelopes alone", () => {
    const sample = envelope("report");
    for (const text of ["Hello", `Explain this:\n${sample}`, `\`\`\`xml\n${sample}\n\`\`\``, `> ${sample}`, sample.replace("</teammate-message>", ""), envelope("report", 'color="pink"'), envelope("report", 'teammate_id="a" teammate_id="b"'), envelope("report", 'teammate_id="a" broken'), envelope(sample)]) {
      expect(teammateMessageParts(text)).toBeNull();
    }
  });

  it("does not discard an unfinished next delivery", () => {
    const tail = '<teammate-message teammate_id="next">unfinished';
    expect(teammateMessageParts(`${envelope("report")}\n${tail}`)?.at(-1)).toEqual({ kind: "text", text: tail });
  });
});
