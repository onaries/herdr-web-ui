import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pages = readFileSync(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");
const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

function indentedSection(source: string, parent: string, name: string, indent: number): string {
  const lines = source.split("\n");
  const parentLine = lines.indexOf(`${" ".repeat(indent - 2)}${parent}:`);
  if (parentLine < 0) throw new Error(`Missing ${parent} section`);
  const prefix = " ".repeat(indent);
  const start = lines.indexOf(`${prefix}${name}:`, parentLine + 1);
  if (start < 0) throw new Error(`Missing ${name} in ${parent}`);
  let end = start + 1;
  for (; end < lines.length; end++) {
    if (new RegExp(`^${prefix}[^\\s#][^:]*:`).test(lines[end] ?? "")) break;
  }
  return lines.slice(start, end).join("\n");
}

const pageJob = (name: string): string => indentedSection(pages, "jobs", name, 2);
const ciJob = (name: string): string => indentedSection(ci, "jobs", name, 2);

describe("Pages deployment gate", () => {
  it("runs reusable CI validation in parallel with the site build and requires both before deployment", () => {
    const validate = pageJob("validate");
    const build = pageJob("build");
    const deploy = pageJob("deploy");
    expect(validate).toContain("uses: ./.github/workflows/ci.yml");
    expect(build).not.toContain("needs:");
    expect(deploy).toMatch(/needs:\s*\[validate, build\]/);
  });

  it("only runs on main, pins checkout to the triggering SHA, and serializes without canceling deployments", () => {
    expect(pages).toMatch(/push:\n\s+branches: \[main\]/);
    expect(pages).toMatch(/workflow_dispatch:\n/);
    for (const name of ["validate", "build", "deploy"]) {
      expect(pageJob(name)).toContain("if: github.ref == 'refs/heads/main'");
    }
    expect(pages).toMatch(/^  group: pages$/m);
    expect(pages).toContain("cancel-in-progress: false");
    expect(ci).toMatch(/group: validation-/);
    expect(pageJob("validate")).toContain("permissions:\n      contents: read");
    expect(pageJob("build")).toContain("ref: ${{ github.sha }}");
    for (const name of ["windows-install", "fast", "integration"]) {
      expect(ciJob(name)).toContain("ref: ${{ github.sha }}");
    }
  });

  it("fails closed on a current-main API error and refuses an outdated build before deployment", () => {
    const deploy = pageJob("deploy");
    expect(deploy).toContain("contents: read");
    expect(deploy).toContain("pages: write");
    expect(deploy).toContain("id-token: write");
    expect(deploy).toContain("set -euo pipefail");
    expect(deploy).toContain('gh api "repos/${GITHUB_REPOSITORY}/commits/main" --jq \'.sha\'');
    expect(deploy).toContain('if [[ "$latest_sha" != "$EXPECTED_SHA" ]]');
    expect(deploy.indexOf("Verify deployment SHA is current")).toBeLessThan(deploy.indexOf("actions/deploy-pages@v5"));
  });

  it("summarizes the validated, built, and deployed source SHAs", () => {
    const deploy = pageJob("deploy");
    expect(deploy).toContain("Validated SHA:");
    expect(deploy).toContain("Built SHA:");
    expect(deploy).toContain("Deployed SHA:");
    expect(deploy).toContain("${{ needs.build.outputs.sha }}");
  });

  it("keeps reports and nested verification evidence for both CI jobs on success or failure", () => {
    expect(ciJob("fast")).toContain("CHECK_DIR: ${{ github.workspace }}/.ci");
    expect(ciJob("integration")).toContain("CHECK_DIR: ${{ github.workspace }}/.ci");
    for (const name of ["fast", "integration"]) {
      const job = ciJob(name);
      expect(job).toContain(".ci/report.json");
      expect(job).toContain("if: always()");
      expect(job).toContain(".ci/**/*.log");
      expect(job).toContain(".ci/browser-evidence/**/*.png");
      expect(job).toContain(".ci/browser-evidence/**/*.json");
      expect(job).toContain(".ci/browser-evidence/**/*.zip");
    }
    expect(ciJob("integration")).toContain(".ci/config/herdr/sessions/*/test-server.log");
  });
});

describe.skipIf(process.platform === "win32")("Pages SHA guard execution", () => {
  const guard = pageJob("deploy").match(/        run: \|\n([\s\S]*?)(?=\n      -)/)?.[1]
    .split("\n").map((line) => line.replace(/^          /, "")).join("\n");
  if (!guard) throw new Error("Missing deployment guard shell");
  const sha = "a".repeat(40);

  for (const scenario of [
    { name: "accepts the validated build at current main", built: sha, latest: sha, api: "0", code: 0 },
    { name: "rejects an older rerun", built: sha, latest: "b".repeat(40), api: "0", code: 1 },
    { name: "rejects an artifact from another commit", built: "b".repeat(40), latest: sha, api: "0", code: 1 },
    { name: "fails closed when GitHub denies the lookup", built: sha, latest: sha, api: "1", code: 1 },
    { name: "rejects a malformed API response", built: sha, latest: "null", api: "0", code: 1 },
  ]) {
    it(scenario.name, () => {
      const root = mkdtempSync(join(tmpdir(), "pages-guard-"));
      try {
        writeFileSync(join(root, "gh"), '#!/usr/bin/env bash\nif [[ "$CASE_API" != 0 ]]; then exit "$CASE_API"; fi\nprintf "%s\\n" "$CASE_LATEST"\n', { mode: 0o700 });
        const result = spawnSync("bash", ["-c", guard], {
          encoding: "utf8",
          timeout: 5_000,
          env: {
            PATH: `${root}:${process.env.PATH}`,
            GITHUB_REPOSITORY: "fixture/repository",
            EXPECTED_SHA: sha,
            BUILT_SHA: scenario.built,
            CASE_API: scenario.api,
            CASE_LATEST: scenario.latest,
          },
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(scenario.code);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
