### Fixed
- While the terminal reconnects, the held input's clipped preview (`Input held: “…”`) answers the
  pointer again, so hovering it shows the whole command; before, the pointer fell through to the
  terminal and the preview's title never showed.
- In a narrow split on a desktop, the reconnecting notice with held input stays inside its pane and
  wraps, instead of running out of the pane's left edge with its first words cut off.
