import "../src/styles.css";
import { Profiler, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatView } from "../src/components/ChatView.tsx";
import { MachineContext } from "../src/lib/machineContext.tsx";
import { SettingsProvider } from "../src/lib/settings.ts";

declare global {
  interface Window {
    chatQa: {
      refresh: () => void;
      page: (direction: -1 | 1) => void;
      resize: (height: number) => void;
      machine: (machine: string) => void;
    };
  }
}

function Fixture() {
  const [refresh, setRefresh] = useState(0);
  const [height, setHeight] = useState(window.innerHeight);
  const [machine, setMachine] = useState("local");
  const pageScroll = useRef<((direction: -1 | 1) => void) | null>(null);
  window.chatQa = {
    refresh: () => setRefresh((value) => value + 1),
    page: (direction) => pageScroll.current?.(direction),
    resize: setHeight,
    machine: setMachine,
  };
  return <div className="terminal-host"><div className="terminal-stack is-chat" style={{ position: "relative", height, width: "100%" }}>
    <MachineContext.Provider value={machine}>
      <Profiler id="chat" onRender={() => window.dispatchEvent(new Event("chat-qa-commit"))}>
        <ChatView key={machine} paneId="same-pane" refreshKey={refresh} connected ended={false} agent={null} agentStatus="working" pageScroll={pageScroll} />
      </Profiler>
    </MachineContext.Provider>
  </div></div>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Chat fixture root missing");
createRoot(root).render(<SettingsProvider><Fixture /></SettingsProvider>);
