import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./ci-runner-route.sh", import.meta.url));
const labels = '["self-hosted","linux","x64","herdr-ci"]';
const repo = "devswha/ovis";

function route(env: Record<string, string>) {
  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    timeout: 5_000,
    env: { PATH: process.env.PATH ?? "", REPOSITORY: repo, ...env },
  });
  expect(result.error).toBeUndefined();
  return result;
}

function routed(env: Record<string, string>): unknown {
  const result = route(env);
  expect(result.status).toBe(0);
  const lines = result.stdout.trimEnd().split("\n");
  expect(lines.length).toBe(1);
  expect(lines[0]).toStartWith("linux=");
  return JSON.parse(lines[0]!.slice("linux=".length));
}

describe.skipIf(process.platform === "win32")("CI runner route", () => {
  it("routes to the maintainer PC's runners without the variable", () => {
    expect(routed({ EVENT_NAME: "pull_request", HEAD_REPO: repo })).toEqual(["self-hosted", "self-hosted-ovis"]);
    expect(routed({ EVENT_NAME: "push" })).toEqual(["self-hosted", "self-hosted-ovis"]);
  });

  it("keeps any other event hosted without the variable", () => {
    for (const event of ["workflow_dispatch", "workflow_run", "merge_group", "schedule", ""]) {
      expect(routed({ EVENT_NAME: event, HEAD_REPO: repo })).toBe("ubuntu-24.04");
    }
  });

  it("keeps everything on the GitHub-hosted image when the variable names it", () => {
    const hosted = '"ubuntu-24.04"';
    expect(routed({ EVENT_NAME: "pull_request", HEAD_REPO: repo, CONFIGURED_LABELS: hosted })).toBe("ubuntu-24.04");
    expect(routed({ EVENT_NAME: "push", CONFIGURED_LABELS: hosted })).toBe("ubuntu-24.04");
    expect(routed({ EVENT_NAME: "workflow_dispatch", REQUESTED_LABELS: labels, CONFIGURED_LABELS: hosted })).toEqual(JSON.parse(labels));
  });

  it("keeps a fork pull request hosted without the variable", () => {
    expect(routed({ EVENT_NAME: "pull_request", HEAD_REPO: "someone/fork" })).toBe("ubuntu-24.04");
    expect(routed({ EVENT_NAME: "pull_request_target", HEAD_REPO: "someone/fork" })).toBe("ubuntu-24.04");
    expect(routed({ EVENT_NAME: "pull_request" })).toBe("ubuntu-24.04");
  });

  it("routes a same-repository pull request to the configured labels", () => {
    expect(routed({ EVENT_NAME: "pull_request", HEAD_REPO: repo, CONFIGURED_LABELS: labels })).toEqual(JSON.parse(labels));
  });

  it("keeps a fork pull request on the GitHub-hosted image", () => {
    expect(routed({ EVENT_NAME: "pull_request", HEAD_REPO: "someone/fork", CONFIGURED_LABELS: labels })).toBe("ubuntu-24.04");
    expect(routed({ EVENT_NAME: "pull_request_target", HEAD_REPO: "someone/fork", CONFIGURED_LABELS: labels })).toBe("ubuntu-24.04");
  });

  it("lets the dispatch input override the variable", () => {
    expect(routed({ EVENT_NAME: "workflow_dispatch", REQUESTED_LABELS: '["self-hosted","other"]', CONFIGURED_LABELS: labels }))
      .toEqual(["self-hosted", "other"]);
    expect(routed({ EVENT_NAME: "workflow_dispatch", REQUESTED_LABELS: labels })).toEqual(JSON.parse(labels));
  });

  it("keeps a fork pull request hosted even with requested labels", () => {
    expect(routed({ EVENT_NAME: "pull_request", HEAD_REPO: "someone/fork", REQUESTED_LABELS: labels, CONFIGURED_LABELS: labels }))
      .toBe("ubuntu-24.04");
  });

  it("routes a push to main to the configured labels", () => {
    expect(routed({ EVENT_NAME: "push", CONFIGURED_LABELS: labels })).toEqual(JSON.parse(labels));
  });

  it("refuses malformed JSON", () => {
    const result = route({ EVENT_NAME: "push", CONFIGURED_LABELS: '["self-hosted",' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("::error::");
  });

  it("refuses labels without self-hosted", () => {
    for (const value of ['["linux","x64"]', '"self-hosted"', '[]', '["self-hosted", 1]']) {
      const result = route({ EVENT_NAME: "workflow_dispatch", REQUESTED_LABELS: value });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("::error::");
    }
  });
});
