### Fixed
- A terminal pane left open and quiet no longer asks herdr for its scroll position every second:
  the scrollbar's poll backs off to every 15 seconds and speeds up again on output, scrolling,
  resizing or returning to the tab. A view scrolled up into history keeps its 1 second read, since
  herdr holds that view still while new output grows the history below it, and a failed read
  still retries after 1 second. Each drawn frame also no longer measures the page layout unless a search has highlights to place, which saves battery on phones.
