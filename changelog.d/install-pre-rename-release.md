### Fixed
- The one-line installers (`install.sh`, `install.ps1`) work again while the latest release still
  names the plugin `devswha.herdr-web-ui`: they install it under that id instead of failing with
  "herdr does not list the plugin after installing it", and they leave an install under the old id
  in place rather than stopping it for a move that release cannot make. The move to `devswha.ovis`
  happens on the first run after a release that names the new id. Where raw.githubusercontent.com
  is blocked, a release's version tells which id it uses.
