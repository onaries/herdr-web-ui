### Maintenance
- herdr RPCs are typed per method (`HerdrMethods`): server code calls `paneProcessInfo`,
  `agentGet` and the other wrappers in `server/herdr/client.ts`, and `server/conventions.test.ts`
  keeps it off the untyped `herdrRpc`, so asking `pane.process_info` by `target` no longer compiles
  without an explicit result type.
