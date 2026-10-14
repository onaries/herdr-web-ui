const OTHER_CONTROL = /\p{C}/gu;

/**
 * Unknown agent labels can contain private-use Nerd Font glyphs. They are data,
 * not a usable fallback initial, so remove them before drawing the fallback mark.
 */
export function fallbackInitial(agent: string): string {
  const clean = agent.normalize("NFKC").replace(OTHER_CONTROL, "").trim();
  return [...clean][0]?.toUpperCase() ?? "?";
}
