#!/usr/bin/env bash
# Runner-side guard (ACTIONS_RUNNER_HOOK_JOB_STARTED): runs before every job, outside anything a
# workflow controls. A pull request's run executes its own workflow files and route script, so a
# fork could send its job here; this refuses every job whose code comes from another repository
# (a fork pull request, a deleted head repository, a workflow_run of a fork) before a step runs.
#
# Fail closed: every exit before the job is explicitly allowed at the end refuses it, an error of
# this script included (a missing or unreadable event file, broken JSON, an unset variable).
# First of all: a write to a closed output (an error message on a stderr nobody reads) must not
# end this shell with SIGPIPE before the refusal below can run.
trap '' PIPE
set -euo pipefail

allowed=0
reason="the guard failed before it could check the job"

refuse() {
  set +e
  [[ "$allowed" == 1 ]] && return
  # nothing may stop this before the kill: a closed output (SIGPIPE) or a signal ends the shell
  # inside its EXIT trap, and the worker would go on
  trap '' PIPE HUP INT TERM
  local refusal pid parent
  # A failing hook only fails its own step: runner v2.338 still runs the job's `if: always()` and
  # `if: failure()` steps and its actions' post steps. So end the job first: SIGKILL the
  # Runner.Worker that runs it (an ancestor of this hook), which leaves no step to run.
  pid=$PPID
  while [[ "$pid" -gt 1 ]]; do
    parent="$(sed -n 's/^PPid:[[:space:]]*//p' "/proc/$pid/status" 2>/dev/null)" || break
    if [[ "$(cat "/proc/$pid/comm" 2>/dev/null)" == Runner.Worker ]]; then
      kill -KILL "$pid"
      break
    fi
    pid="${parent:-0}"
  done
  refusal="This self-hosted runner only runs code from ${GITHUB_REPOSITORY:-its own repository}; refusing ${GITHUB_EVENT_NAME:-this} job${GITHUB_RUN_ID:+ $GITHUB_RUN_ID}: $reason."
  echo "::error::$refusal" 2>/dev/null
  # the job's log never reaches GitHub once its worker is killed: say it in the container's own
  # output too, which the launcher's journal keeps
  echo "[job-started] $refusal" 2>/dev/null >/proc/1/fd/2
  exit 1
}
trap refuse EXIT

repository="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
event_path="${GITHUB_EVENT_PATH:?GITHUB_EVENT_PATH is required}"

reason="its event file $event_path could not be read as JSON"
head="$(jq -r --arg repo "$repository" '
  if has("pull_request") then (.pull_request.head.repo.full_name // "")
  elif has("workflow_run") then (.workflow_run.head_repository.full_name // "")
  else $repo end' "$event_path")"

if [[ "$head" != "$repository" ]]; then
  reason="its code comes from ${head:-an unknown repository}"
  exit 1
fi

allowed=1
echo "Runner guard: ${GITHUB_EVENT_NAME:-job} from $repository"
