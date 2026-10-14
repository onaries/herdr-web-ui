#!/usr/bin/env bash
# Picks the runner for ci.yml's Linux jobs and prints `linux=<json>` for $GITHUB_OUTPUT.
# A fork pull request always gets the GitHub-hosted image: its code must never reach the
# self-hosted runner. Otherwise the workflow_dispatch input wins over the repository variable
# CI_SELF_HOSTED_LABELS, and with neither the job stays on ubuntu-24.04.
set -euo pipefail

hosted='"ubuntu-24.04"'
event="${EVENT_NAME:-}"
requested="${REQUESTED_LABELS:-}"
configured="${CONFIGURED_LABELS:-}"

choose_labels() {
  local source="$1" value="$2" compact
  if ! compact=$(jq -ce 'if type == "array" and length > 0 and all(.[]; type == "string") and any(.[]; . == "self-hosted") then . else error("invalid") end' <<<"$value" 2>/dev/null); then
    echo "::error::$source must be a JSON array of strings that contains \"self-hosted\", got: $value" >&2
    exit 1
  fi
  echo "Runner: self-hosted $compact (from $source)" >&2
  echo "linux=$compact"
}

if [[ ("$event" == "pull_request" || "$event" == "pull_request_target") && "${HEAD_REPO:-}" != "${REPOSITORY:-}" ]]; then
  echo "Runner: ubuntu-24.04 (pull request from fork ${HEAD_REPO:-unknown})" >&2
  echo "linux=$hosted"
elif [[ -n "${requested//[[:space:]]/}" ]]; then
  choose_labels "workflow_dispatch input self_hosted_labels" "$requested"
elif [[ -n "${configured//[[:space:]]/}" ]]; then
  choose_labels "repository variable CI_SELF_HOSTED_LABELS" "$configured"
else
  echo "Runner: ubuntu-24.04 (CI_SELF_HOSTED_LABELS unset)" >&2
  echo "linux=$hosted"
fi
