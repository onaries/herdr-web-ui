#!/usr/bin/env bash
# Host launcher: keeps N ephemeral runner containers alive, one job per container.
#
# Usage: scripts/self-hosted-runner/run.sh [--repo OWNER/NAME] [--count N] [--labels herdr-ci]
#                                          [--build] [--once]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="herdr-ci-runner:local"

REPO=""
COUNT=1
LABELS="herdr-ci"
BUILD=0
ONCE=0

usage() {
  sed -n '2,5p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:?--repo needs a value}"; shift 2 ;;
    --count) COUNT="${2:?--count needs a value}"; shift 2 ;;
    --labels) LABELS="${2:?--labels needs a value}"; shift 2 ;;
    --build) BUILD=1; shift ;;
    --once) ONCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$COUNT" in ''|*[!0-9]*|0) echo "--count must be a positive integer" >&2; exit 2 ;; esac

if [ -z "$REPO" ]; then
  REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
fi
HOST="$(hostname -s)"
PREFIX="herdr-ci-${HOST}-"

if [ "$BUILD" = 1 ] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -t "$IMAGE" "$SCRIPT_DIR"
fi

slot_loop() {
  local slot="$1" name token container_status
  name="${PREFIX}${slot}"
  while true; do
    if ! token="$(gh api -X POST "repos/$REPO/actions/runners/registration-token" --jq .token)"; then
      echo "[$name] could not fetch a registration token; retrying in 30s" >&2
      [ "$ONCE" = 1 ] && return 1
      sleep 30
      continue
    fi
    # No docker socket, no host mounts, no privileges. tini is already the entrypoint.
    # The token goes in on stdin (entrypoint.sh), so it is never in the container's environment.
    if printf '%s\n' "$token" | docker run --rm -i \
      --name "$name" \
      --security-opt no-new-privileges \
      --cap-drop ALL \
      --pids-limit 8192 \
      --shm-size 2g \
      -e RUNNER_URL="https://github.com/$REPO" \
      -e RUNNER_NAME="$name" \
      -e RUNNER_LABELS="$LABELS" \
      "$IMAGE"; then
      container_status=0
    else
      container_status=$?
      echo "[$name] container exited with status $container_status" >&2
    fi
    token=""
    [ "$ONCE" = 1 ] && return "$container_status"
    sleep 2
  done
}

PIDS=()
cleaned=0
cleanup() {
  [ "$cleaned" = 1 ] && return
  cleaned=1
  trap '' INT TERM
  echo "stopping runner slots..." >&2
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  for slot in $(seq 1 "$COUNT"); do
    docker stop -t 30 "${PREFIX}${slot}" >/dev/null 2>&1 || true
  done
  wait 2>/dev/null || true
  # Remove any runner of this host that is still registered.
  ids="$(gh api "repos/$REPO/actions/runners" --paginate \
    --jq ".runners[] | select(.name | startswith(\"$PREFIX\")) | .id" 2>/dev/null || true)"
  for id in $ids; do
    gh api -X DELETE "repos/$REPO/actions/runners/$id" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for slot in $(seq 1 "$COUNT"); do
  slot_loop "$slot" &
  PIDS+=("$!")
done

if [ "$ONCE" = 1 ]; then
  rc=0
  for pid in "${PIDS[@]}"; do
    wait "$pid" || rc=$?
  done
  exit "$rc"
fi

# Slot loops run until a signal arrives; `wait` is interrupted by the traps.
wait
