import { expect, test } from "bun:test";
import { releaseNotes } from "./release-notes.ts";

const manifest = 'name = "herdr-web-ui"\nversion = "1.2.3"\n';
const changelog = '# Changelog\n\n## [Unreleased]\nFuture\n\n## [1.2.3] — today\n\n- Fixed input.\n\n## [1.2.2]\nOld\n\n[1.2.3]: https://example.com\n';
const told = { en: { fixed: ["Input."] }, ko: { fixed: ["입력."] }, ja: { fixed: ["入力。"] }, zh: { fixed: ["输入。"] }, tr: { fixed: ["Girdi."] } };
const summaries = JSON.stringify({ "1.2.3": told, "1.2.2": { en: { fixed: ["Old."] } } });
test("release notes belong only to the exact requested version", () => {
  expect(releaseNotes("1.2.3", "1.2.3", manifest, changelog, summaries)).toBe(
    "### Bug fixes\n\n- Input.\n\n<details><summary>Full changelog</summary>\n\n- Fixed input.\n\n</details>");
});
test("release notes are the English patch-note lists in order, then the changelog section folded", () => {
  const en = { fixed: [" Crash. ", "Hang."], new: ["Cards."], improved: ["Speed."] };
  const all = JSON.stringify({ "1.2.3": { ...told, en } });
  expect(releaseNotes("1.2.3", "1.2.3", manifest, changelog, all)).toBe([
    "### New features\n\n- Cards.",
    "### Improvements\n\n- Speed.",
    "### Bug fixes\n\n- Crash.\n- Hang.",
    "<details><summary>Full changelog</summary>\n\n- Fixed input.\n\n</details>",
  ].join("\n\n"));
  const empty = JSON.stringify({ "1.2.3": { ...told, en: { new: [], improved: ["Speed."] } } });
  expect(releaseNotes("1.2.3", "1.2.3", manifest, changelog, empty)).toStartWith("### Improvements\n\n- Speed.\n\n<details>");
});
test("a summary line stays one line of text: no break and no tag can hide the changelog fold", () => {
  const tagged = JSON.stringify({ "1.2.3": { ...told, en: { fixed: ["Copy <!-- markers."] } } });
  expect(releaseNotes("1.2.3", "1.2.3", manifest, changelog, tagged)).toStartWith("### Bug fixes\n\n- Copy &lt;!-- markers.\n\n<details>");
  for (const ja of ["入力。\n\n<!--", "入\r力。"]) {
    expect(() => releaseNotes("1.2.3", "1.2.3", manifest, changelog, JSON.stringify({ "1.2.3": { ...told, ja: { fixed: [ja] } } }))).toThrow("one line");
  }
});
test("invalid versions and mismatched metadata cannot be released", () => {
  for (const version of ["v1.2.3", "1.2.3-rc.1", "01.2.3", "1.2.3\n", "1.2.3; echo bad", ""]) {
    expect(() => releaseNotes(version, version, manifest, changelog, summaries)).toThrow();
  }
  expect(() => releaseNotes("1.2.3", "1.2.4", manifest, changelog, summaries)).toThrow("package.json");
  expect(() => releaseNotes("1.2.3", "1.2.3", 'version = "1.2.4"', changelog, summaries)).toThrow("herdr-plugin.toml");
});
test("missing, prefix-matched, duplicate and empty notes cannot be released", () => {
  for (const text of ["## [1.2.30]\nWrong", "## [1.2.3]extra\nWrong", "## [1.2.3]\n\n## [1.2.2]\nOld", "## [1.2.3]\nA\n## [1.2.3]\nB"]) {
    expect(() => releaseNotes("1.2.3", "1.2.3", manifest, text, summaries)).toThrow();
  }
});
test("a release that is not told in every language of the app cannot be released", () => {
  const { zh: _zh, ...three } = told;
  for (const text of ["", "{}", JSON.stringify({ "1.2.2": told }), JSON.stringify({ "1.2.3": three }), JSON.stringify({ "1.2.3": { ...told, ja: { fixed: ["  "] } } }), JSON.stringify({ "1.2.3": { ...told, ja: "入力。" } })]) {
    expect(() => releaseNotes("1.2.3", "1.2.3", manifest, changelog, text)).toThrow("release-summaries.json");
  }
  expect(() => releaseNotes("1.2.3", "1.2.3", manifest, changelog, JSON.stringify({ "1.2.3": three }))).toThrow("zh");
});
