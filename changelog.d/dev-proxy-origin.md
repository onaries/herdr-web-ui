### Maintenance
- `bun run dev` no longer answers every state-changing request with 403 `invalid_origin`: Vite's
  `/api` proxy keeps the browser's Host, which the server's same-origin check compares with Origin.
