### Changed
- App, site and demo builds run Vite 8 on Bun rather than the first Node on PATH,
  while type checking uses TypeScript 7. The terminal sidecar still supports Node 18,
  and the client keeps its previous browser syntax targets.
  ([#830](https://github.com/devswha/herdr-web-ui/pull/830) by @todor-a)
- The browser client uses React 19.3, with native inert handling for offline
  workspaces and nullable refs for the settings and tab controls.
- Chat turn times now tell yesterday and older turns apart ("yesterday at 04:45 PM", "9/23 02:30
  PM") and show the full date and time on hover or focus.
- Chat glides to new output while an agent works and you follow the end, instead of snapping to it;
  reduced motion keeps the instant scroll.
- A Markdown image on a line of its own holds a 16:9 slot until it decodes and keeps it with an
  "Image unavailable" note if it cannot, so a document moves at most once per picture; chat
  thumbnails keep their box through loading and failure the same way.
- A work block opens and folds at its measured height: the rows slide out from under the header and
  back, a row opened inside it grows it at the same pace, and the reader's scroll position holds
  through both; reduced motion snaps it.
- The file browser shows folders relative to the pane's own directory (`herdr/src/components`)
  instead of from `~/`; folders outside it keep the `~/` form.
- Keep the selected `/` command or `@` file completion highlighted in the composer when matching
  results refresh for the same query.
- The phone keyboard viewport resyncs when the page becomes visible or is restored.
- Composer attachments with an empty or generic browser MIME type infer their image preview and
  upload type from a PNG, JPEG, GIF or WebP filename extension.
- Under the chat lens, connection and input notices (another app holding the pane, a failed output
  stream, input held for the terminal, a copy note) stand as rows over the input card instead of
  floating top-right, each dismissible with an X; a dismissed notice returns when it changes or
  recurs. A notice holding input typed while disconnected cannot be dismissed, so Send and Discard
  stay reachable.
- **Files → Changes** lists the changed files under their folders: a folder sits where its first
  file was listed with its file count, a lone chain of folders is one row, a tap folds a folder, and
  a button beside Refresh folds or opens them all.
- Reopening a diff or a long file is faster: the syntax-highlight workers are shared across the app
  and stay warm for 30 s after the last viewer closes, and a theme switch no longer restarts them.
- Workspace rows in the sidebar show the project's own favicon, when its folder has one, instead of
  the plain folder glyph.
- Chat images open in a full-screen viewer with the message's other images a step away,
  pointer-anchored zoom and pan, and Copy image and Download actions, instead of a new tab.
- Copying a chat selection keeps Markdown lists, code and image links, with sanitized rich HTML for
  pasting into documents; code-only selections stay plain code.
- A slim strip tucked under the chat composer's card, as t3code's, can name the pane's working
  folder and branch.
- A long user message folds to twelve lines behind **Show full message**, opens again with **Show
  less** or when Find lands on it, and keeps that choice while the chat scrolls.
- A work row now says what the agent said the call is for (OmO's eval summary, the description
  Claude gives a Bash command or a subagent) instead of the tool id or the raw command, which stays
  in the opened row and its tooltip. Opening a tool's whole output keeps its work row in place.

### Added
- The chat box says when a draft hits the 20 000-character cap, and how many characters of a paste
  were left out, instead of silently stopping.
- The context ring's opened label has a Compact button that sends `/compact` in one tap, shown only
  for agents that list the command.
- A **Quote in message** button appears after you select text in the terminal and adds the
  selection to that pane's chat draft, headed by the pane name and line range. It only fills the
  draft; nothing is sent.
- Skill names an agent writes in an answer (`/name`, or `$name` for Codex) show as chips, matched
  against the pane's own skill list, and copy as the raw text.
- The diff viewer's header gains **Copy path** (the repository-relative path, with no patch
  needed), and the viewer and the Changes list draw placeholder rows while they load so the layout
  holds.
- The command palette finds Settings pages and actions by related words (try "theme" or "font"),
  opens the page directly, and lists matches found only through such words after title matches.
- File rows in the Files dialog's Browse and Changes lists and in the folder browser show a glyph
  for the file's kind (code, JSON, config, image, archive, lockfile, ...) and mark a `.git` folder,
  so a list can be scanned at a glance.
- With Theme set to System, **Settings → Appearance** picks separate Light and Dark palettes and
  switches between them with the OS.
- **Settings → Shortcuts** records a binding by pressing it (Escape cancels; reserved, unbindable
  and already-assigned chords are refused on the row), and a search field filters the shortcut
  list.
- Long native conversations mount a window of rows while keeping selected and focused
  rows available. Reading position survives older messages and streaming; expanded work
  and fetched full outputs survive scrolling away. Chat Find (Cmd/Ctrl+F) searches loaded
  source, including folded work, and can search earlier pages with cancellation and retry.
- **Files → Changes** lists what changed in the repository a pane sits in: the working tree, the
  index, or two commits named by hand, one row per file with git's status letter, the path (a
  rename's old path too) and its added and removed lines. A row opens the file's diff from
  `@pierre/diffs` as a bounded window of rows, unified or side by side (Settings → File viewer →
  Diff layout; a phone shows one column and says so), with old and new line numbers, the context
  around each change folded to a line or shown whole, the file itself one tap away on the PC that
  holds it, and the patch copied as git printed it. Binary, too-large, conflicted and vanished
  changes, a folder outside git and a commit that does not exist each say what they are. Back,
  Escape and Close each close the diff alone and return the focus to its row; a remote PC's
  repository reads through its bridge; the demo answers from its fixture.
- The file viewer opens a source file whole up to 8 MB and 200 000 lines (a Markdown file keeps
  its 256 KB Preview), and draws a source of more than 2 000 lines as a window of rows from
  `@pierre/diffs`, so a 120 000-line file scrolls with a few hundred rows in the page. Up to
  256 KB and 5 000 lines the rows are colored in the package's own worker; a longer source stays
  plain and says so. A line reference reveals its line against the mounted row, on a phone with
  wrapping too; a cut file says whether its bytes or its lines ended it; and Copy, without a
  clipboard, shows the whole source as a selected text box.
- File links with `:line[:column]` or `#Lline[-Lline]` open the source at the first
  requested line, including Markdown reader tabs. Lines outside the bounded preview
  are explained rather than silently opening at the top.
- The command palette browses folders: type a path such as `~/` (or pick **Browse folders**) to walk
  the PC's folders, jump to the folder of a pinned agent or a recent folder, and open the one you
  reach in Files. The Files dialog has a button that opens the palette already browsing its current
  folder.
- In Settings, the Chat font and Terminal font fields can be picked from a searchable, previewed list of
  the fonts installed on this device in Chromium browsers, and the terminal refuses proportional
  fonts.
- **Settings → Appearance → Typography** sets the interface font size on this device, apart from the
  terminal's and the chat's own.
- Chat work blocks list the files their edit tools changed in the turn, and a click opens the file's
  current working-tree diff.
- Coming back to a pane's chat puts you on the same turn and offset you left, or at the end if you
  were following it; the place is remembered per pane and PC for the life of the tab.
- A conversation of four or more turns shows a rail of short dashes left of the chat, one per
  message you sent with the one in view marked; click a dash, or focus it and press Enter, to jump
  to that turn. It is hidden on a phone and wherever the chat column leaves no margin.

### Fixed
- The diagram viewer's toolbar keeps clear of a notch or rounded corner on a phone held sideways.
- A long Markdown file opens its Preview in parts, so the page no longer stalls for about a second on a slow machine while it draws.
