### Added
- Dracula, Nord and Vesper are available on either theme side, with readable status and code colors.
- Herdr's seven light/dark theme pairs now have CSS theme rows with readable text, agent
  states and code colors, plus upstream source and license attribution.
- Settings → Appearance picks a dark theme and a light theme from every theme, as herdr does:
  picking one of a pair fills the other side with its sibling until that side is chosen by hand,
  and a dark theme chosen for light mode still draws dark.
### Changed
- CONTRIBUTING.md now takes a new theme only when herdr ships it as a built-in, written as a
  CSS theme block with reviewed overrides that pass AA. DESIGN.md and the guide describe the dark
  and light theme pickers.
