# Self-hosted CI runner

An ephemeral Docker GitHub Actions runner for this repository's Linux CI/CD jobs. Each container registers, runs exactly one job and exits; the launcher then starts a fresh one. The image includes Bun, Node 22, checksum-pinned herdr, Playwright Chromium and its system libraries, ffmpeg, git, `gh`, curl, jq, unzip and xz-utils, with no sudo. Jobs detect it with `RUNNER_ENVIRONMENT=self-hosted`.

## Prerequisites

- Docker on a Linux x64 host.
- `gh` logged in as a repository admin (needed to create registration tokens and delete runners).

## Run

```sh
scripts/self-hosted-runner/run.sh                         # 1 slot, repo from the current checkout
scripts/self-hosted-runner/run.sh --count 3
scripts/self-hosted-runner/run.sh --repo OWNER/NAME --labels herdr-ci --build
scripts/self-hosted-runner/run.sh --once                  # one container per slot, then exit
```

The image `herdr-ci-runner:local` is built when missing or with `--build`. Ctrl+C stops the containers and deletes any runner of this host (`herdr-ci-<host>-*`) still registered.

`--once` exits nonzero if registration-token retrieval or any container fails. Its exit status
reports launcher/container execution, not the GitHub Actions job's conclusion.

Runner containers have no CPU or total-memory quota and can use available host resources. The
`--shm-size 2g` Docker setting sizes `/dev/shm` for browser scratch space; it is not a total RAM
limit. The container still has a pids limit of 8192.

## Prepared tools and caches

Self-hosted jobs verify the image's Bun version, requested Node major and herdr checksum instead
of downloading tools. Both browser lanes use the installed project's Playwright revision to find
Chromium under `/opt/playwright-browsers`; a missing browser fails with rebuild guidance, not a
download fallback. Rebuild with `--build` after changing the tool pins or Playwright in `bun.lock`.
The image's `BUN_VERSION` must match the default in `.github/actions/setup-ci/action.yml`, and
`PLAYWRIGHT_VERSION` must match the lockfile.

Bun dependencies are installed from `bun.lock`, with the local install-cache directory at
`.ci-cache/bun` retained inside the checkout. Only hosted jobs restore and save that directory as
a remote dependency cache. Disposable self-hosted jobs install fresh with the frozen lockfile:
on the measured connection, that took 7–20s versus 37–43s to transfer the cache archive. Hosted
browser caches use `.ci-cache/playwright`; self-hosted jobs skip that remote cache because the
browser is already in the image. Workspace-relative archives avoid restoring home-directory paths
from a different checkout depth (GitHub's workspace versus `/w`).

This removes per-job tool/browser downloads, not all network traffic: checkout, dependency
installation and artifact transfers still use the network. Compare setup time, test time and retries separately
on the same commit before claiming an end-to-end speedup. No persistent host cache is mounted into
the disposable containers.

## Routing jobs to it

```sh
gh variable set CI_SELF_HOSTED_LABELS --body '["self-hosted","linux","x64","herdr-ci"]'
gh variable delete CI_SELF_HOSTED_LABELS   # back to GitHub-hosted ubuntu-24.04
```

A manual run can override the variable with the `self_hosted_labels` workflow_dispatch input. Fork PRs always use `ubuntu-24.04`; Windows/macOS jobs, `remote-bundles.yml` and `windows-install.yml` stay GitHub-hosted.

## Security model

This is a public repository. Fork PR workflow runs need maintainer approval, and a fork PR can edit `runs-on`, so reading the workflow changes before approving is the real boundary. Containers are ephemeral (`--ephemeral`, `--rm`), unprivileged (`--cap-drop ALL`, `no-new-privileges`, no `--privileged`), have no host mounts and no Docker socket, and the image has no sudo. The registration token reaches the container on stdin, never through its environment, so a job cannot read it from `/proc/1/environ`.
