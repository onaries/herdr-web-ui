# Self-hosted CI runner

An ephemeral Docker GitHub Actions runner for this repository's Linux CI/CD jobs. Each container registers, runs exactly one job and exits; the launcher then starts a fresh one. The image includes Bun, Node 22, checksum-pinned herdr, Playwright Chromium and its system libraries, ffmpeg, git, `gh`, curl, jq, unzip and xz-utils, with no sudo. Jobs detect it with `RUNNER_ENVIRONMENT=self-hosted`.

## Prerequisites

- Docker on a Linux x64 host.
- `gh` logged in as a repository admin (needed to create registration tokens and delete runners).

## Run

```sh
scripts/self-hosted-runner/run.sh                         # 1 slot, repo from the current checkout
scripts/self-hosted-runner/run.sh --count 3
scripts/self-hosted-runner/run.sh --repo OWNER/NAME --labels self-hosted-ovis --build
scripts/self-hosted-runner/run.sh --once                  # one container per slot, then exit
```

The image `herdr-ci-runner:local` is built when missing or with `--build`. Ctrl+C stops the containers and deletes any runner of this host (`herdr-ci-<host>-*`) still registered.

A slot that cannot fetch a registration token retries after 30 s, doubling up to 10 minutes: GitHub
limits these requests per hour, and eight slots retrying every 30 s keep the account over that limit,
which blocks every other API call too. After the repository is renamed, restart the launcher with
`--repo OWNER/NEW-NAME`: the token request follows GitHub's redirect, but runner registration does
not, and every container exits with a 404.

`--once` exits nonzero if registration-token retrieval or any container fails. Its exit status
reports launcher/container execution, not the GitHub Actions job's conclusion.

Runner containers have no CPU or total-memory quota and can use available host resources.
They all join the network namespace of one idle container, `herdr-ci-<host>-net`, which the
launcher starts first and stops last. The runners therefore share a loopback, and with it
`scripts/check.ts`'s slots: the herdr-backed CI lanes of every runner on the PC count against one
`CHECK_MAX_RUNS` and wait for a slot, instead of each runner believing it has the PC to itself.
The namespace is not the host's: a job still cannot reach a service on the host's loopback. The
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

`ci.yml`'s Linux jobs go to `["self-hosted","self-hosted-ovis"]` by default, the launcher's default
label. The repository variable overrides that:

```sh
gh variable set CI_SELF_HOSTED_LABELS --body '"ubuntu-24.04"'   # PC offline: everything GitHub-hosted
gh variable set CI_SELF_HOSTED_LABELS --body '["self-hosted","self-hosted-ovis"]'   # pages.yml and release.yml too
gh variable delete CI_SELF_HOSTED_LABELS   # back to the default
```

On the maintainer PC the launcher runs as the systemd user unit `ovis-ci-runner.service`
(`run.sh --repo devswha/ovis --count 4 --labels self-hosted-ovis` from a copy of this directory in
`~/.local/share/ovis-ci-runner`): four slots let one CI run's four Linux jobs start together, and
`check.ts`'s shared slots still cap its herdr-backed lanes at three. Copy the directory again and
restart the unit after changing these files.

A manual run can override the variable with the `self_hosted_labels` workflow_dispatch input. Fork PRs always use `ubuntu-24.04`; Windows/macOS jobs, `remote-bundles.yml` and `windows-install.yml` stay GitHub-hosted.

## Security model

This is a public repository. A fork PR's run uses the fork's workflow files and `scripts/ci-runner-route.sh`, so it can choose `runs-on` itself. The runner therefore enforces the boundary: `job-started.sh` runs before every job (`ACTIONS_RUNNER_HOOK_JOB_STARTED`, set in the image, outside the workflow's control) and refuses any job whose event names another head repository (a fork pull request, a deleted head repository, a `workflow_run` of a fork). It fails closed: any exit before it explicitly allows the job, an error of its own included (a missing or unreadable event file, broken JSON, an unset variable), refuses it, and the refusal kills the worker before it logs anything, with SIGPIPE and termination signals ignored, so a closed output cannot stop it halfway. A failing hook alone is not enough: runner v2.338 marks only its "Set up runner" step failed and still runs the job's `if: always()` and `if: failure()` steps. So the hook SIGKILLs the job's `Runner.Worker` before it returns; the job then ends as failed within seconds with no step run and an empty log, and the refusal is written to the container's output (`journalctl --user -u ovis-ci-runner`). Both were checked on a live runner with a refused job: the old exit-only hook ran the `always()` and `failure()` steps, the killing hook ran none. Fork PR runs also need maintainer approval (repository setting: all outside collaborators); never approve one that changes `runs-on`. Containers are ephemeral (`--ephemeral`, `--rm`), unprivileged (`--cap-drop ALL`, `no-new-privileges`, no `--privileged`), have no host mounts and no Docker socket, and the image has no sudo. The registration token reaches the container on stdin, never through its environment, so a job cannot read it from `/proc/1/environ`.
