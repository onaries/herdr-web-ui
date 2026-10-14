### Fixed
- Sending a held message from two browser tabs no longer submits it twice. Its unconfirmed mark
  survives other tabs refreshing or disconnecting, and unreadable storage refuses a resend.
  After a confirmed no-input refusal, Send now starts a new attempt instead of replaying the refusal.
