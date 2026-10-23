#!/usr/bin/env bash
# Container entrypoint: register one ephemeral runner, then run exactly one job.
set -euo pipefail

: "${RUNNER_URL:?RUNNER_URL is required}"
# The registration token arrives on stdin, never in the environment: a container's initial
# environment stays readable in /proc/1/environ by every process of the same user, jobs included.
IFS= read -r RUNNER_TOKEN || true
: "${RUNNER_TOKEN:?a registration token is required on stdin}"
: "${RUNNER_NAME:?RUNNER_NAME is required}"
RUNNER_LABELS="${RUNNER_LABELS:-self-hosted-ovis}"

./config.sh --unattended --ephemeral \
  --url "$RUNNER_URL" \
  --token "$RUNNER_TOKEN" \
  --name "$RUNNER_NAME" \
  --labels "$RUNNER_LABELS" \
  --work /w \
  --replace

unset RUNNER_TOKEN
exec ./run.sh </dev/null
