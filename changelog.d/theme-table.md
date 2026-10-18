### Maintenance
- Theme colors now live only in the theme blocks of `src/styles.css`. `bun run generate:themes`
  writes the terminal colors, DESIGN.md's amber table, the `theme-color` tag and the web manifest
  colors from them, and fast checks fail when a copy is stale. Nothing changes on screen.
