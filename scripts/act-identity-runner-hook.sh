#!/bin/bash
# Job-started hook for the credential-bearing identity delivery runner (docs/act-pilot-identity-delivery.md, section 8).
#
# The owner installs one copy of this reviewed file per runner instance, outside the runner directory and every checkout, with
# an owner-only file act-identity-runner-hook.conf beside it:
#
#   REPOSITORY=OWNER/REPO                      the one repository whose jobs may run here
#   RUNNER_WORK=/absolute/path/to/runner/_work this instance's work directory (its event payload lives under it)
#   NODE=/absolute/path/to/node                the Node binary that judges the payload
#
# and names the copy in that instance's .env as ACTIONS_RUNNER_HOOK_JOB_STARTED. The runner runs it before any step of every
# job; a non-zero exit fails the job before a step runs. It admits one thing: a job (deliver or cleanup) of
# .github/workflows/act-identity-delivery.yml on main, started by workflow_dispatch in REPOSITORY. Everything else is refused.
#
# What it trusts: the repository, the work directory and the Node binary come from the owner-only file, never from the
# environment. The ref, the workflow and the repository come from the event payload the runner wrote at the fixed path under
# RUNNER_WORK, never from GITHUB_EVENT_PATH. GitHub's GITHUB_* variables must agree as well, but no decision rests on them
# alone, because a job may be able to set its own environment. The payload is judged by Node in an empty environment
# (env -i), so NODE_OPTIONS, NODE_PATH and the like cannot reach it. Limit: bash reads BASH_ENV before the first line here
# runs, so a job environment that reached this hook could still run code first; the owner's proof shows it does not.
set -euo pipefail
unset NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_REPL_EXTERNAL_MODULE BASH_ENV ENV CDPATH GLOBIGNORE
IFS=$' \t\n'
PATH=/usr/bin:/bin

refuse() {
  printf 'ALZ_IDENTITY_RUNNER_REFUSED: %s. This runner runs only the identity delivery workflow, dispatched on main.\n' "$1" >&2
  exit 1
}

here="${BASH_SOURCE[0]}"
case "$here" in /*) ;; *) refuse "the hook is not installed at an absolute path" ;; esac
conf="${here%/*}/act-identity-runner-hook.conf"
[ -f "$conf" ] && [ ! -L "$conf" ] || refuse "act-identity-runner-hook.conf is missing beside the hook"
node=""
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in NODE=*) node="${line#NODE=}" ;; esac
done < "$conf"
[[ "$node" =~ ^/[A-Za-z0-9._/-]{1,400}$ ]] && [ -x "$node" ] || refuse "act-identity-runner-hook.conf names no absolute NODE binary"

/usr/bin/env -i "$node" -e '
  "use strict";
  const fs = require("node:fs");
  const [hook, conf, repository, eventName, ref, workflowRef, job, eventPath] = process.argv.slice(1);
  const refuse = (reason) => { process.stderr.write("ALZ_IDENTITY_RUNNER_REFUSED: " + reason + ". This runner runs only the identity delivery workflow, dispatched on main.\n"); process.exit(1); };
  const WORKFLOW = ".github/workflows/act-identity-delivery.yml";
  const uid = process.getuid();
  const ownerOnly = (path, what, mask) => {
    let stat;
    try { stat = fs.lstatSync(path); } catch { refuse(what + " is missing"); }
    if (stat.isSymbolicLink() || !stat.isFile()) refuse(what + " is not a regular file");
    if (stat.uid !== uid || (stat.mode & mask) !== 0) refuse(what + " is not owner-only");
  };
  ownerOnly(hook, "the hook", 0o022);
  ownerOnly(conf, "act-identity-runner-hook.conf", 0o077);
  const settings = {};
  for (const line of fs.readFileSync(conf, "utf8").split("\n")) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    const match = /^(REPOSITORY|RUNNER_WORK|NODE)=(.+)$/.exec(line);
    if (!match || Object.hasOwn(settings, match[1])) refuse("act-identity-runner-hook.conf has an unknown or repeated line");
    settings[match[1]] = match[2];
  }
  const repo = settings.REPOSITORY ?? "";
  const work = settings.RUNNER_WORK ?? "";
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repo)) refuse("act-identity-runner-hook.conf names no REPOSITORY");
  if (!/^\/[A-Za-z0-9._\/-]{1,400}$/.test(work) || work.split("/").includes("..")) refuse("act-identity-runner-hook.conf names no absolute RUNNER_WORK");
  // The job variables must agree, but the payload decides.
  if (repository !== repo) refuse("the job is from another repository");
  if (eventName !== "workflow_dispatch") refuse("the job was not started by workflow_dispatch");
  if (ref !== "refs/heads/main") refuse("the job is not on main");
  if (workflowRef !== repo + "/" + WORKFLOW + "@refs/heads/main") refuse("the job is not the identity delivery workflow on main");
  if (job !== "deliver" && job !== "cleanup") refuse("the job is not one of the delivery workflow jobs");
  const payloadPath = work + "/_temp/_github_workflow/event.json";
  if (eventPath !== "" && eventPath !== payloadPath) refuse("GITHUB_EVENT_PATH is not this runner payload");
  ownerOnly(payloadPath, "the event payload", 0o022);
  if (fs.realpathSync(payloadPath) !== payloadPath) refuse("the event payload is not at its own real path");
  let payload;
  try { payload = JSON.parse(fs.readFileSync(payloadPath, "utf8")); } catch { refuse("the event payload is not JSON"); }
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  // A workflow_dispatch payload: the dispatched ref, the workflow file path as a string, and the inputs.
  if (!isObject(payload) || payload.ref !== "refs/heads/main" || payload.workflow !== WORKFLOW || !isObject(payload.inputs) ||
    !isObject(payload.repository) || payload.repository.full_name !== repo) {
    refuse("the event payload is not a dispatch of the identity delivery workflow on main");
  }
  process.stdout.write("ALZ identity runner admitted " + WORKFLOW + " (job " + job + ").\n");
' "$here" "$conf" "${GITHUB_REPOSITORY:-}" "${GITHUB_EVENT_NAME:-}" "${GITHUB_REF:-}" "${GITHUB_WORKFLOW_REF:-}" "${GITHUB_JOB:-}" "${GITHUB_EVENT_PATH:-}" \
  || refuse "the job did not pass the check"
