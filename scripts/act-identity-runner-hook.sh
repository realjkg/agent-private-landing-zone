#!/usr/bin/env bash
# Job-started hook for the credential-bearing identity delivery runner (docs/act-pilot-identity-delivery.md).
#
# The owner copies this reviewed file to the runner host, outside the runner's work directory and outside any checkout, and names
# it in the runner's .env as ACTIONS_RUNNER_HOOK_JOB_STARTED, with ALZ_IDENTITY_RUNNER_REPOSITORY=OWNER/REPO beside it. The
# runner runs it before any step of every job it takes; a non-zero exit fails the job before a step runs. It admits exactly one
# thing: a job of .github/workflows/act-identity-delivery.yml on main, started by workflow_dispatch in that repository. Any other
# workflow, branch, tag, pull request, fork, event or job is refused, so no untrusted code runs on this runner even if a
# pull request names its label. It reads only GitHub's default variables and the event payload; it prints no secret.
set -euo pipefail

refuse() {
  printf 'ALZ_IDENTITY_RUNNER_REFUSED: %s. This runner runs only the identity delivery workflow, dispatched on main.\n' "$1" >&2
  exit 1
}

repo="${ALZ_IDENTITY_RUNNER_REPOSITORY:-}"
[[ "$repo" =~ ^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$ ]] || refuse "ALZ_IDENTITY_RUNNER_REPOSITORY is not set to OWNER/REPO in the runner's .env"
workflow=".github/workflows/act-identity-delivery.yml"

[ "${GITHUB_REPOSITORY:-}" = "$repo" ] || refuse "the job is from another repository"
[ "${GITHUB_EVENT_NAME:-}" = "workflow_dispatch" ] || refuse "the job was not started by workflow_dispatch"
[ "${GITHUB_REF:-}" = "refs/heads/main" ] || refuse "the job is not on main"
[ "${GITHUB_WORKFLOW_REF:-}" = "$repo/$workflow@refs/heads/main" ] || refuse "the job is not the identity delivery workflow on main"
case "${GITHUB_JOB:-}" in
  deliver|cleanup) ;;
  *) refuse "the job is not one of the delivery workflow's jobs" ;;
esac

# The event payload the runner received must say the same thing.
event="${GITHUB_EVENT_PATH:-}"
[ -n "$event" ] && [ -f "$event" ] && [ ! -L "$event" ] || refuse "the event payload is missing"
node -e '
  const [file, repo, workflow] = process.argv.slice(1);
  let payload;
  try { payload = JSON.parse(require("node:fs").readFileSync(file, "utf8")); } catch { process.exit(1); }
  const ok = payload !== null && typeof payload === "object" && payload.ref === "refs/heads/main" && payload.workflow === workflow &&
    payload.repository !== null && typeof payload.repository === "object" && payload.repository.full_name === repo;
  process.exit(ok ? 0 : 1);
' "$event" "$repo" "$workflow" || refuse "the event payload is not a dispatch of the identity delivery workflow on main"

printf 'ALZ identity runner admitted %s (job %s, run %s).\n' "$workflow" "$GITHUB_JOB" "${GITHUB_RUN_ID:-?}"
