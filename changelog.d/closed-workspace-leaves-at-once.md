### Fixed
- A closed workspace leaves the sidebar as soon as herdr closes it, about half a second sooner:
  its panes send no exit, so browsers used to learn of it only after the next roster refresh.
  Removing a worktree does the same. ([#1017](https://github.com/devswha/herdr-web-ui/pull/1017), [#944](https://github.com/devswha/herdr-web-ui/pull/944) by @todor-a)
