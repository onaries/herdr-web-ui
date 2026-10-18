# Grok chat

The reader shows Grok's user messages, assistant text and expandable tool rows in
the existing Chat view. Terminal remains the place for approvals. Reading chat makes no
model calls. Reasoning, images and child-session expansion are outside this first scope.

**Supported executable:** on Linux, chat follows any Grok executable named `grok` or
`grok-…`, including a versioned build such as `grok-1.0.52-linux-x86_64` and a binary
replaced while it was still running. macOS and Windows show the terminal view, because the
held-file check reads Linux `/proc`. Lifecycle checks used Grok 1.0.50 and Herdr 0.9.3.
No installer changes the Grok configuration.

Chat shows Thinking or Working from the bound transcript's current turn even if Herdr
reports ready or done. A native completion clears that indicator; late background tool
results do not restart it. This describes the transcript's turn, not input readiness, and
an interrupted turn without a saved completion may remain active until another native
turn or rewind replaces it. Unavailable native history is explicitly marked in Chat.

## Finding the active session

The bridge reads the foreground Grok process's environment for `GROK_HOME`, or
`HOME/.grok` when unset. The pane's Grok process is found in Herdr's foreground list.
Foreground discovery and the executable check both accept `grok` or `grok-…`, with
packaging suffixes removed; neither requires a particular build number or a numeric suffix.
A reported ID is looked up exactly, including hashed directory names for long paths;
directory or modification time never chooses a conversation.

Grok 1.0.50 does not fire `SessionStart` on an in-TUI `/resume`, so Herdr can keep an old ID.
`active_sessions.json` and open file descriptors can contain several sessions; neither
identifies which of them is on screen. Chat is therefore shown only when the process's sole
held `events.jsonl` session agrees with Herdr's ID. After a `/resume` that leaves them apart,
or any other ambiguity, the pane uses the terminal view. That same rule applies to every
Grok executable. Builds other than 1.0.50 were not each re-checked; an ambiguous hold still
stays on the terminal view.

## History and limits

The adapter reuses the shared transcript pager and response contract. It applies rewind
markers in file order before paging; a marker changes history identity even before a new
prompt arrives. Old cursors return 409. Compaction records do not discard displayed turns.
Hidden prompts still separate turns; `syntheticPrompt` alone does not hide a message.

Tool updates replace present fields and preserve omitted fields. Native tool names come
from `_meta["x.ai/tool"].name` when ACP `name` is absent. Diffs are retained separately when
later content replaces them. Long output references include store, session/history, call
and output revision, so expanded output cannot remain pinned to an earlier result.
Terminal-reference blocks are shown as references; their separate ACP output is not fetched.

Reads scan at most 32 MiB per catch-up, in bounded chunks, and keep at most 100,000 indexed
prompts/tools per file and 16 indexes. Lines over 16 MiB and unreconstructable history use
the terminal fallback. Newest pages use the shared 16 MiB window; older pages can widen to
64 MiB. A mid-turn page missing its tool-call seed, an unknown/abandoned/earlier-owner update,
or a malformed history-control record is unavailable rather than silently misrepresented.

**Known limitation:** one malformed or unreconstructable record makes that file
terminal-only until it is replaced or shrinks. Later appends do not bring chat back, because
skipping the record could misplace a rewind.

## Verification

```sh
HERDR_TEST_MODE=unit bun test ./server/grok.test.ts
bun run check run bun test ./server/api.contract.test.ts --test-name-pattern 'Grok conversation API'
bun run check run --build bun scripts/grok-chat-browser-qa.ts
bun run check fast
```

The contract test uses an isolated real Herdr and a disposable stand-in process named
`grok-1.0.52-linux-x86_64`; it also unlinks the running binary to cover Linux's ` (deleted)`
marker. It verifies HTTP identity and cursor behavior, not the native TUI.
Native fictional captures separately establish replay equivalence after nested rewinds.
The browser test runs the real built client against fictional files and checks retained
expanded output after updates, shrink and rewind. It never opens the user's browser session.
Native tool writes are also captured from a fictional printf call. Dashboard/background
switching, forks and other builds and platforms remain release-validation work; synthetic
fixtures do not establish those behaviors.
