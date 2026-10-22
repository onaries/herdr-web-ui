### Changed
- The herdr plugin is now `devswha.ovis`, installed from `devswha/ovis` on GitHub. Running the
  one-line installer again moves an install under `devswha.herdr-web-ui`: it stops the old
  plugin, installs the new one with the old one's settings and token, and removes the old id.
  An install updated with `herdr plugin update` instead shows as `devswha.ovis` and keeps its
  settings and token, but herdr still uninstalls it by its old id (see Uninstall in the guide).
