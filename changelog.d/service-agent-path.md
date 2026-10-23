### Fixed
- A server run as a service now offers and starts OmO and Gajae Code when they are installed only on
  its user's login-shell PATH (such as `~/.local/bin`), and starts the same executable it offered.
  The login shell runs only when the agent list or a start needs it, at most once a minute, and
  the server logs why when it gives no PATH.
