import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// the faces the tokens name, then styles.css before any component: it holds the primitives
// (.btn, .input, .menu…) that component stylesheets override, and Vite emits CSS in import order
import "./fonts/fonts.css";
import "./styles.css";
import { App } from "./App.tsx";
import { FileReader } from "./components/FileReader.tsx";
import { readerFromSearch } from "./lib/fileReader.ts";
import { SettingsProvider } from "./lib/settings.ts";
import "./lib/viewport.ts";
import { watchSheetExits } from "./lib/sheets.ts";

// a phone's sheets drop back down however they close (lib/sheets.ts)
watchSheetExits();

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from index.html");

// a markdown file opened in a tab of its own is that page alone, not the app (FileReader)
const reader = readerFromSearch(window.location.search);

createRoot(container).render(
  <StrictMode>
    <SettingsProvider>
      {reader !== null ? <FileReader target={reader} /> : <App />}
    </SettingsProvider>
  </StrictMode>,
);
