### Maintenance
- On Windows, the browser and SSH scripts find the test herdr session: they look under
  `XDG_CONFIG_HOME` first, then `%APPDATA%`, as herdr does.
  ([#884](https://github.com/devswha/herdr-web-ui/pull/884) by @willowite,
  [#1032](https://github.com/devswha/herdr-web-ui/pull/1032))
