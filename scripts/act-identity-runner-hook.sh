#!/bin/bash
# Job-started hook for the credential-bearing identity delivery runner (docs/act-pilot-identity-delivery.md, section 8).
#
# The owner installs one copy of this reviewed file per runner instance, outside the runner directory and every checkout, with
# an owner-only file act-identity-runner-hook.conf beside it:
#
#   REPOSITORY=OWNER/REPO                      the one repository whose jobs may run here
#   RUNNER_WORK=/absolute/path/to/runner/_work this instance's work directory (its event payload lives under it)
#   NODE=/absolute/path/to/node                the Node binary that judges the payload (owned by root or this user, not writable by others)
#
# and names the copy in that instance's .env as ACTIONS_RUNNER_HOOK_JOB_STARTED. The runner runs it before any step of every
# job; a non-zero exit fails the job before a step runs. It admits one thing: a job (deliver or cleanup) of
# .github/workflows/act-identity-delivery.yml on main, started by workflow_dispatch in REPOSITORY. Everything else is refused.
#
# What it trusts: the repository, the work directory and the Node binary come from the owner-only file, never from the
# environment. The ref, the workflow and the repository come from the event payload the runner wrote at the fixed path under
# RUNNER_WORK, never from GITHUB_EVENT_PATH. GITHUB_* variables must agree as well, but they can only add refusals. Node judges
# everything again in an empty environment (env -i) and is the last command, so its verdict is the hook's exit status.
#
# How it is written: bash looks a command name up among functions before builtins, and an exported function in the environment
# (BASH_FUNC_<name>%%) becomes such a function. So this script calls no builtin or outside function by name: it uses only
# keywords ([[ ]], if, case), expansions, assignments, its own function and programs by absolute path. Nothing it calls can be
# replaced from the environment.
#
# What it cannot defend: bash itself acts on BASH_ENV, ENV, SHELLOPTS and BASHOPTS before this file's first line runs (BASH_ENV
# can run code; SHELLOPTS can set noexec, which would read this file without running it and exit 0). If a job's environment
# reaches this hook, that is a full bypass. The first check below makes a leak visible: a job environment carrying
# ALZ_HOOK_ENV_CANARY, BASH_ENV or ENV is refused with ALZ_IDENTITY_HOOK_ENV_LEAK, and the owner's proof (section 11, step 7)
# sets the canary on every instance. If that code ever appears, the runner must not be used (section 12).
#
# Portability (the MBP runs Apple's /bin/bash 3.2 and BSD userland unless the runner finds another bash first): the bash part uses
# no counted regex repetition (BSD's limit is 255), no \d, \w or \s, and only an unquoted variable on the right of =~, in the C
# locale; /usr/bin/find uses only POSIX -H, -prune, -perm -mode, -user, -o and -print; printf and env take no GNU-only flag.
PATH=/usr/bin:/bin
IFS=$' \t\n'
LC_ALL=C

if [[ -n "${ALZ_HOOK_ENV_CANARY+x}" || -n "${BASH_ENV+x}" || -n "${ENV+x}" ]]; then
  /usr/bin/printf '%s\n' "ALZ_IDENTITY_HOOK_ENV_LEAK: a job's environment reached the job-started hook (ALZ_HOOK_ENV_CANARY, BASH_ENV or ENV is set). The hook cannot protect this runner; do not use it for identity delivery (docs/act-pilot-identity-delivery.md, section 12)." >&2
  /usr/bin/false
else
  reason=""
  here="${BASH_SOURCE[0]}"
  conf="${here%/*}/act-identity-runner-hook.conf"
  node=""
  if [[ "$here" != /* ]]; then
    reason="the hook is not installed at an absolute path"
  elif [[ ! -f "$conf" || -L "$conf" ]]; then
    reason="act-identity-runner-hook.conf is missing beside the hook"
  elif [[ ! -O "$conf" || -n "$(/usr/bin/find "$conf" -prune \( -perm -040 -o -perm -020 -o -perm -010 -o -perm -004 -o -perm -002 -o -perm -001 \) -print)" ]]; then
    reason="act-identity-runner-hook.conf is not owner-only"
  else
    settings="$(< "$conf")"
    framed=$'\n'"$settings"$'\n'
    node_line=$'\n''NODE=(/[A-Za-z0-9._/-]+)'$'\n'
    if [[ $framed =~ $node_line ]]; then node="${BASH_REMATCH[1]}"; fi
    if [[ -z "$node" || ${#node} -gt 400 || ! -f "$node" || ! -x "$node" ]]; then
      reason="act-identity-runner-hook.conf names no absolute NODE binary"
    elif [[ -n "$(/usr/bin/find -H "$node" -prune \( -perm -020 -o -perm -002 \) -print)" || -z "$(/usr/bin/find -H "$node" -prune \( -user 0 -o -user "$EUID" \) -print)" ]]; then
      reason="the NODE binary is writable by group or others, or owned by someone other than root or this user"
    fi
  fi
  if [[ -n "$reason" ]]; then
    /usr/bin/printf 'ALZ_IDENTITY_RUNNER_REFUSED: %s. This runner runs only the identity delivery workflow, dispatched on main (bash %s).\n' "$reason" "${BASH_VERSION:-unknown}" >&2
    /usr/bin/false
  else
    /usr/bin/env -i "$node" -e '
      "use strict";
      const fs = require("node:fs");
      const [hook, conf, repository, eventName, ref, workflowRef, job, eventPath, bashVersion] = process.argv.slice(1);
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
      const binary = fs.statSync(fs.realpathSync(process.execPath));
      if ((binary.uid !== 0 && binary.uid !== uid) || (binary.mode & 0o022) !== 0) refuse("the NODE binary is writable by group or others, or owned by someone other than root or this user");
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
      process.stdout.write("ALZ identity runner admitted " + WORKFLOW + " (job " + job + "; hook ran under bash " + bashVersion + ").\n");
    ' "$here" "$conf" "${GITHUB_REPOSITORY:-}" "${GITHUB_EVENT_NAME:-}" "${GITHUB_REF:-}" "${GITHUB_WORKFLOW_REF:-}" "${GITHUB_JOB:-}" "${GITHUB_EVENT_PATH:-}" "${BASH_VERSION:-unknown}"
  fi
fi
