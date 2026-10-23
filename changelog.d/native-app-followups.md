### Fixed
- The iOS app no longer keeps every page it left in memory: each Change PC used to leave the old
  web view behind.
- The iOS app no longer shows a white screen while a page loads with the phone in light mode,
  such as the seconds of a first launch.
- The Android app's launch screen and system bars are dark like the app instead of white, and
  the bars take the color of the page's top bar, with icons that stand out on it.
- The app's error page says why a PC could not be opened on Android too, and shows up when a PC
  answers with an HTTP error (such as a 502 while Ovis is stopped there) instead of keeping that
  page and saving the PC. Its buttons also work on older Android WebViews.
- The Android app leaves its data out of backups and moves to a new phone, so a paired PC's
  sign-in cannot be restored elsewhere.
- Debug builds of both apps no longer write pairing links to the device log. Release builds
  already had this logging turned off.

### Changed
- The connect screen warns before opening a plain http address outside a tailnet or home
  network, as the pairing code would cross the internet unencrypted.
