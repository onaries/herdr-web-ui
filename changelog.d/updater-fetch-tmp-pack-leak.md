### Fixed
- The updater now removes the temporary `tmp_pack_*` files a failed fetch leaves in the checkout,
  including the ones earlier versions left behind (any untouched for an hour is swept), and no
  longer retries a failed history (unshallow) fetch every 5 minutes. On Linux and macOS a fetch
  that runs out of time is ended with SIGTERM first, so that Git releases its lock files
  ([#1258](https://github.com/devswha/herdr-web-ui/pull/1258) by @mkitaev).
