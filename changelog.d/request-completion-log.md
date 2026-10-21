### Added
- HTTP requests and WebSocket handshakes now carry request IDs and write bounded completion
  records in the app's state directory, so the owner can correlate a response with its request.
