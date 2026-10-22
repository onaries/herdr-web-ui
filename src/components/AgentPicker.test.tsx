import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentPicker, type AgentPickerProps } from "./AgentPicker.tsx";

const agents = [{ kind: "codex", label: "Codex" }, { kind: "claude", label: "Claude Code" }];
const render = (props: Partial<AgentPickerProps>): string =>
  renderToStaticMarkup(createElement(AgentPicker, { agents, value: "", labelledBy: "agent", onChange: () => {}, ...props }));

describe("AgentPicker", () => {
  it("leads with a plain shell, and shows the chosen agent's mark with its name", () => {
    expect(render({})).toContain('class="agent-picker-shell"');
    const claude = render({ value: "claude" });
    expect(claude).toContain('class="agent-mark claude is-brand"');
    expect(claude).toContain('class="agent-picker-label">Claude Code<');
  });

  it("lists the agents alone when told so: no shell, and a value outside the list falls to the first agent", () => {
    const codex = render({ shell: false, value: "codex" });
    expect(codex).toContain('class="agent-mark codex"');
    expect(codex).toContain('class="agent-picker-label">Codex<');
    expect(codex).not.toContain("agent-picker-shell");
    expect(render({ shell: false, value: "" })).toContain('class="agent-picker-label">Codex<');
  });
});
