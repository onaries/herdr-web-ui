import { useCallback, useState } from "react";
import { paletteOpenQuery } from "./paletteSeed.ts";

export function useCommandPalette() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const openPalette = useCallback((query?: unknown) => { setPaletteQuery(paletteOpenQuery(query)); setPaletteOpen(true); }, []);
  return { paletteOpen, paletteQuery, openPalette, setPaletteOpen };
}
