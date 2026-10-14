# src/

- The auth token lives only in the HttpOnly cookie, never in localStorage or sessionStorage.
- A new setting needs its default and type check in `sanitizeSettings`, or it is silently dropped.
- Secret input stays in the DOM input only: never React state, a draft, a queue or a retry.
- Import only types from `shared/protocol.ts`: importing a value reads the server's environment.
- Ordinary working OmO sends use bridge `hold`; only the pending row's explicit ListEnd action transfers to the native queue. Held input, offline/uncertain state and connection ownership still gate both sends.
- Native questions keep the server's prompt and option keys through `/api/pane/prompt/answer`; never guess digit keys.
- Keep compaction feedback and the newest 12-prompt read window with upstream tab retention and conversation caching, not private hidden retention.
