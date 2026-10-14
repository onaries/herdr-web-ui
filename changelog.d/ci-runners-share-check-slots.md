### Maintenance
- The self-hosted CI runners of one PC share `bun run check`'s slots: their Integration and
  Browser regression jobs wait for a slot instead of all running at once and failing each other's
  timing-bound tests.
