### Maintenance
- The browser scripts and `scripts/check.test.ts` run on a Mac as they are: a script without
  `CHROME_PATH` falls back to the lockfile's Playwright Chromium where Google Chrome's Linux path
  does not exist, the check tests make their scratch directories under `/tmp` so a socket inside
  stays within the path limit, and `scripts/output-browser-qa.ts` opens its page in English
  whatever the PC's language.
