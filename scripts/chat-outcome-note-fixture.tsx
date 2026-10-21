import React from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import { ChatView } from "../src/components/ChatView.tsx";
import { SettingsProvider } from "../src/lib/settings.ts";

function Fixture() {
  return <main style={{ height: "100vh" }}><ChatView paneId="opencode-pane" refreshKey={0} connected ended={false} agent="opencode" /></main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><SettingsProvider><Fixture /></SettingsProvider></React.StrictMode>);
