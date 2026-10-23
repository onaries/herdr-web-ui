### Changed
- The herdr plugin is now `devswha.ovis`, installed from `devswha/ovis` on GitHub. Running the
  one-line installer again moves an install under `devswha.herdr-web-ui`: it stops the old
  plugin, installs the new one with the old one's settings and token, and removes the old id.
  `herdr plugin update` does not move the id: an install it updates stays under
  `devswha.herdr-web-ui` until the one-line installer runs again.
