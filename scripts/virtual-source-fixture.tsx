import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/fonts/fonts.css";
import "../src/styles.css";
import { FileViewer } from "../src/components/FileViewer.tsx";
import { MachineContext } from "../src/lib/machineContext.tsx";
import { SettingsProvider, useSettings, type Settings } from "../src/lib/settings.ts";
declare global { interface Window { virtualQA: { open: (path: string, machine?: string) => void; close: () => void; settings: (patch: Partial<Settings>) => void } } }
function Fixture() {
  const [target, setTarget] = useState<{ path: string; machine: string } | null>(null);
  const { update } = useSettings();
  window.virtualQA = { open: (path, machine = "local") => setTarget({ path, machine }), close: () => setTarget(null), settings: update };
  return <main>
    <button type="button">Outside</button>
    {target && <MachineContext.Provider value={target.machine}><FileViewer key={`${target.machine}:${target.path}`} path={target.path} paneId={null} onClose={() => setTarget(null)} /></MachineContext.Provider>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><SettingsProvider><Fixture /></SettingsProvider></React.StrictMode>);
