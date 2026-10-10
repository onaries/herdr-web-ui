import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";

it("includes the bundled highlighter's complete installed license in the distributed notices", () => {
  const notices = readFileSync(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
  const license = readFileSync(new URL("../node_modules/@tanstack/highlight/LICENSE", import.meta.url), "utf8");
  expect(notices).toContain("@tanstack/highlight");
  expect(notices).toContain(license.trim());
});
