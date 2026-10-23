### Added
- The Android app can take the PC's alerts as push notifications through Firebase Cloud
  Messaging, once the app is built with a Firebase project: it registers with the push relay
  per PC, decrypts each alert on the phone (the relay and Google cannot read it) and shows it.
  Without Firebase set up, the app builds and runs as before. The client starts using it in a
  later change.
