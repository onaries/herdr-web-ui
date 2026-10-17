### Changed
- Every agent's `/` menu (and Codex's `$`) now reads the way omo's does: each command's
  description is one short line with the whole text in its tooltip, skills stand under where they
  come from (yours, this project's, built in, from a plugin) with an icon for each, a namespaced
  name such as `/skill:x`, `/plugin:x` or `/prompts:x` keeps the menu open past its `:`, and the
  skill names in your own messages show as chips. A command's description is no longer cut at 120
  characters, and a multi-line one in a skill's frontmatter arrives whole.
