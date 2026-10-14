import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import { FileViewer } from "../src/components/FileViewer.tsx";
import { SettingsProvider } from "../src/lib/settings.ts";
declare global { interface Window { previewQA: { open: (path: string) => void } } }
function Fixture() {
  const [path, setPath] = useState<string | null>(null);
  window.previewQA = { open: setPath };
  return <main><button type="button">Outside</button>{path && <FileViewer key={path} path={path} paneId={null} onClose={() => setPath(null)} />}</main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><SettingsProvider><Fixture /></SettingsProvider></React.StrictMode>);
