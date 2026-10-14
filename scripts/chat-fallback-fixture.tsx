import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import { ChatView } from "../src/components/ChatView.tsx";
import { SettingsProvider } from "../src/lib/settings.ts";
declare global { interface Window { chatFallbackQA: { pane: (pane: string) => void; refresh: () => void; agent: (agent: string | null) => void } } }
function Fixture() {
  const [agent, setAgent] = useState<string | null>("codex");
  const [pane, setPane] = useState("agent");
  const [refresh, setRefresh] = useState(0);
  window.chatFallbackQA = { pane: setPane, agent: setAgent, refresh: () => setRefresh((key) => key + 1) };
  return <main style={{ height: "100vh" }}><ChatView key={pane} paneId={pane} refreshKey={refresh} connected ended={false} agent={pane === "shell" ? null : agent} /></main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><SettingsProvider><Fixture /></SettingsProvider></React.StrictMode>);
