#!/bin/bash
# The owner's guided acceptance runner for the first supervised AWS cost-baseline run in DEV (docs/mac-acceptance-runner.md).
# Run it on the execution host (the Mac Mini), from the root of a clean, bootstrapped checkout at the commit that carries the
# owner's reviewed limits contract:
#
#   scripts/mac-acceptance.sh --dry-run --readonly-profile NAME --requester-key KEY.pem
#   scripts/mac-acceptance.sh           --readonly-profile NAME --requester-key KEY.pem
#   scripts/mac-acceptance.sh --resume  --readonly-profile NAME --requester-key KEY.pem
#
# What it does: a host preflight with exact fixes, then the brief's existing commands in order (docs/act-aws-terraform-execution-
# brief.md, "Cost baseline as payload"), each shown, run, journaled (exit code, output SHA-256, times) and stopped on failure
# with the next action; then an owner-only evidence bundle with acceptance-report.md for items 1 to 8.
#
# What it never does: type a phrase, sign, pick a key, or answer any prompt of the product (each ./alz apply command gets the
# person's own terminal through script(1), and the script feeds it nothing); run without a terminal past a human gate; propose
# or run a cleanup (the disposition is RETAIN); enable ACT, write the contract or change an approval; print a token or a key.
# It authorizes nothing. Its evidence is the owner's own, collected on the owner's host: not CI, not agent-collected.
#
# Portability (Apple's /bin/bash 3.2 and the BSD userland, like scripts/act-identity-runner-hook.sh and scripts/release-stage.sh):
# no associative arrays, mapfile, case conversion, |& or &>>, no GNU-only flags (stat -c, sed -i, readlink -f, realpath), and
# only POSIX find predicates. JSON work goes to scripts/mac-acceptance.mjs (node, which the product already needs).
set -o pipefail
umask 077

SELF_DIR="$(cd -P -- "$(dirname -- "$0")" && pwd -P)"
ROOT="$(cd -P -- "$SELF_DIR/.." && pwd -P)"
HELPER="$ROOT/scripts/mac-acceptance.mjs"
ALZ="$ROOT/alz"
BASE="$ROOT/.runs/mac-acceptance"
IDENTITIES="DISCOVERY STATE STATE_WRITE APPLY"

DRY_RUN=0
RESUME=0
BUNDLE_ONLY=0
KEEP_ACCOUNT=no
PROFILE=""
REQUESTER=""
APPROVER=""
REQUESTER_KEY=""
APPROVER_KEY=""
REFUSED_DIR=""

usage() {
  cat <<'EOF'
Usage: scripts/mac-acceptance.sh [--dry-run | --resume | --bundle] --readonly-profile NAME
         [--requester ID] [--requester-key KEY.pem] [--approver ID] [--approver-key KEY.pem]
         [--refused-example CANARY_COPY_DIR] [--include-account-id]

  --dry-run             Run the host preflight and print every step's exact command. Touches no cloud, writes no run state.
  --resume              Continue the current run: completed steps are skipped, the failed step runs again.
  --bundle              Write the evidence bundle from the current run as it stands, without running further steps.
  --readonly-profile    A separate, read-only AWS CLI profile for the DEV account. Used only by the build's read-only
                        preview and by ./alz cost status, never by the pilot identities.
  --requester, --approver
                        Allowlisted ids from the contract (default: the contract's only approver id).
  --requester-key, --approver-key
                        Your Ed25519 key files (mode 0600). Passed to ./alz apply as --key, never stored or copied.
                        The approver key defaults to the requester key (in DEV one person may request and approve).
  --refused-example DIR Opt in to acceptance item 6's refused example: a seal of this log-group canary copy, expected to stop
                        with RESOURCE_NOT_IN_LIMITS. It runs a real, read-only DISCOVERY plan in the account.
  --include-account-id  Keep the account id in the evidence bundle (it is masked by default).

The script never types a phrase, signs, or answers a prompt, and never proposes or runs a cleanup (disposition RETAIN).
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --resume) RESUME=1 ;;
    --bundle) BUNDLE_ONLY=1 ;;
    --include-account-id) KEEP_ACCOUNT=yes ;;
    --readonly-profile|--requester|--approver|--requester-key|--approver-key|--refused-example)
      if [ $# -lt 2 ] || [ -z "$2" ]; then echo "mac-acceptance: $1 needs a value" >&2; exit 2; fi
      case "$1" in
        --readonly-profile) PROFILE="$2" ;;
        --requester) REQUESTER="$2" ;;
        --approver) APPROVER="$2" ;;
        --requester-key) REQUESTER_KEY="$2" ;;
        --approver-key) APPROVER_KEY="$2" ;;
        --refused-example) REFUSED_DIR="$2" ;;
      esac
      shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "mac-acceptance: unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
if [ $((DRY_RUN + RESUME + BUNDLE_ONLY)) -gt 1 ]; then echo "mac-acceptance: choose one of --dry-run, --resume and --bundle" >&2; exit 2; fi

cd "$ROOT" || exit 1

# --- output ------------------------------------------------------------------------------------------------

say() { printf '%s\n' "$*"; }
rule() { say "------------------------------------------------------------------------------------------"; }
FAILS=0
CHECKLIST=""
# check STATE LABEL DETAIL [FIX]: one checklist line. STATE is PASS, FAIL, WAIT or INFO; a FAIL stops the run.
check() {
  local line
  line="$(printf '  %-4s  %-28s %s' "$1" "$2" "$3")"
  CHECKLIST="$CHECKLIST$line"$'\n'
  if [ -n "$4" ]; then CHECKLIST="$CHECKLIST$(printf '        Fix: %s' "$4")"$'\n'; fi
  if [ "$1" = "FAIL" ]; then FAILS=$((FAILS + 1)); fi
}

# --- helpers -----------------------------------------------------------------------------------------------

helper() { node "$HELPER" "$@"; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# kv FILE KEY: the last value of KEY in a key=value file, or nothing.
kv() {
  local file="$1" key="$2" line value=""
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in "$key="*) value="${line#*=}" ;; esac
  done < "$file"
  printf '%s' "$value"
}
# owner_only PATH: a regular file of this user, not a link, with no group or other permission bits.
owner_only() {
  [ -f "$1" ] && [ ! -L "$1" ] && [ -O "$1" ] && [ -z "$(find "$1" -prune \( -perm -040 -o -perm -020 -o -perm -010 -o -perm -004 -o -perm -002 -o -perm -001 \) -print 2>/dev/null)" ]
}
# The pilot identity variables and the refused fallbacks (FALLBACK_VARIABLE in src/apply/providers/aws.ts), by name only.
identity_vars() {
  local id
  for id in $IDENTITIES; do printf '%s\n' "ALZ_${id}_AWS_ROLE_ARN" "ALZ_${id}_AWS_WEB_IDENTITY_TOKEN_FILE" "ALZ_${id}_AWS_REGION"; done
}
fallback_vars() {
  local name
  for name in $(compgen -e); do
    case "$name" in
      AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_SECURITY_TOKEN|AWS_PROFILE|AWS_DEFAULT_PROFILE|AWS_SHARED_CREDENTIALS_FILE|AWS_CONFIG_FILE) printf '%s ' "$name" ;;
      AWS_CONTAINER_*|AWS_EC2_METADATA*|ARM_*|AZURE_*|GOOGLE_*|GCLOUD_*|CLOUDSDK_*|GCE_*) printf '%s ' "$name" ;;
    esac
  done
}
# A child environment for the read-only steps: the pilot identities removed, the owner's read-only profile set.
readonly_env() {
  local args=() name
  for name in $(identity_vars); do args+=( -u "$name" ); done
  env "${args[@]}" AWS_PROFILE="$PROFILE" "$@"
}

# script(1) gives a command the person's terminal and records what it shows. util-linux and BSD differ in syntax; both are
# told to run /bin/sh, which records the command's own exit status in RC_FILE.
SCRIPT_KIND=""
detect_script() {
  if [ -n "$SCRIPT_KIND" ]; then return 0; fi
  if ! command -v script >/dev/null 2>&1; then SCRIPT_KIND="none"; return 0; fi
  if script --version >/dev/null 2>&1; then SCRIPT_KIND="util-linux"; else SCRIPT_KIND="bsd"; fi
}
RC_WRAPPER='rc_file=$1; shift; "$@"; code=$?; printf "%s\n" "$code" > "$rc_file"; exit "$code"'
# in_terminal TRANSCRIPT RC_FILE CMD...: runs CMD on a terminal; stdin and stdout stay the person's own (nothing is fed to it,
# nothing is captured from it but the transcript). The command's exit status is left in TERMINAL_EXIT.
TERMINAL_EXIT=""
in_terminal() {
  local transcript="$1" rc="$2" line
  shift 2
  detect_script
  rm -f "$rc"
  case "$SCRIPT_KIND" in
    util-linux)
      line="$(printf '%q ' /bin/sh -c "$RC_WRAPPER" sh "$rc" "$@")"
      SHELL=/bin/bash script -q -e -c "$line" "$transcript" ;;
    bsd) script -q "$transcript" /bin/sh -c "$RC_WRAPPER" sh "$rc" "$@" ;;
    *) say "script(1) is missing: it is part of macOS (/usr/bin/script)." >&2; return 1 ;;
  esac
  local fallback=$?
  TERMINAL_EXIT="$fallback"
  if [ -s "$rc" ]; then TERMINAL_EXIT="$(sed -n '1p' "$rc")"; fi
  return 0
}

# --- the committed contract and its DEV target -------------------------------------------------------------

ACCOUNT=""; REGION=""; STATE_BUCKET=""; KILL_SWITCH=""; HAS_LIMITS=""; PROVIDER=""; APPROVER_IDS=""
read_contract() {
  local out
  out="$(helper contract "$ROOT" 2>/dev/null)" || return 1
  ACCOUNT="$(printf '%s\n' "$out" | sed -n 's/^ACCOUNT=//p')"
  REGION="$(printf '%s\n' "$out" | sed -n 's/^REGION=//p')"
  STATE_BUCKET="$(printf '%s\n' "$out" | sed -n 's/^STATE_BUCKET=//p')"
  KILL_SWITCH="$(printf '%s\n' "$out" | sed -n 's/^KILL_SWITCH=//p')"
  HAS_LIMITS="$(printf '%s\n' "$out" | sed -n 's/^HAS_LIMITS=//p')"
  PROVIDER="$(printf '%s\n' "$out" | sed -n 's/^PROVIDER=//p')"
  APPROVER_IDS="$(printf '%s\n' "$out" | sed -n 's/^APPROVER_IDS=//p')"
}

# --- preflight ---------------------------------------------------------------------------------------------

PREFLIGHT_DIR=""
preflight() {
  local os version node_version pinned head marker dirty out row name fix value arn region token missing_tokens bad
  PREFLIGHT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/alz-mac-acceptance.XXXXXX")" || { say "Cannot create a private temporary folder." >&2; exit 1; }
  chmod 700 "$PREFLIGHT_DIR"

  os="$(uname -s 2>/dev/null)"
  if [ "$os" = "Darwin" ]; then
    version="$(sw_vers -productVersion 2>/dev/null)"
    check PASS "macOS" "${version:-unknown version} ($(uname -m 2>/dev/null))"
  else
    check FAIL "macOS" "this host is ${os:-unknown}, not macOS" "run this script on the Mac Mini execution host"
  fi
  check PASS "bash" "${BASH_VERSION} at ${BASH:-unknown}"

  if ! command -v node >/dev/null 2>&1; then
    check FAIL "Node" "node is not on PATH" "install Node with ./alz deps guidance (docs/operator-guide.md), then open a new Terminal"
    say "Preflight checklist (stopped early: node is needed for the remaining checks)"
    printf '%s' "$CHECKLIST"
    return 1
  fi
  node_version="$(node --version 2>/dev/null)"
  pinned="$(helper node-major "$ROOT" 2>/dev/null)"
  node_version="${node_version#v}"
  if [ -n "$pinned" ] && [ "${node_version%%.*}" = "$pinned" ]; then
    check PASS "Node" "$node_version (the repository pins $pinned.x in config/tool-pins.json)"
  else
    check FAIL "Node" "running ${node_version:-none}, needs ${pinned:-the pinned major}.x" "install Node ${pinned:-the pinned major}.x and put it first on PATH"
  fi

  head="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)"
  if [ -z "$head" ] || [ "$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null)" != "$ROOT" ]; then
    check FAIL "Checkout" "$ROOT is not the top of a git checkout" "run the script from a clone of the repository"
  else
    check PASS "Checkout" "commit $head"
  fi
  dirty="$(git -C "$ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${dirty:-1}" = "0" ]; then
    check PASS "Clean worktree" "no uncommitted changes (git-ignored config/cost.json does not count)"
  else
    check FAIL "Clean worktree" "$dirty uncommitted or untracked path(s)" "commit or stash them (git status); the build stops with SOURCE_WORKTREE_DIRTY and seal refuses uncommitted contract changes"
  fi
  marker="$ROOT/dist/.alz-build-complete"
  local built=0
  if [ -f "$marker" ] && [ -n "$head" ] && grep -q "\"sourceCommit\": \"$head\"" "$marker"; then
    built=1
    check PASS "Built dist/" "dist/ was built from $head"
  else
    check FAIL "Built dist/" "dist/ is missing or was built from another commit" "./alz bootstrap"
  fi

  if [ "$built" = 1 ]; then
    out="$("$ALZ" deps </dev/null 2>&1)"
    printf '%s\n' "$out" > "$PREFLIGHT_DIR/deps.txt"
    local section=pilot
    while IFS= read -r row; do
      case "$row" in "Product tools"*) section=product ;; esac
      [ "$section" = pilot ] || continue
      case "$row" in
        "OK  "*) name="${row#OK  }"; check PASS "${name%% — *}" "${name#* — } (./alz deps)" ;;
        "NEEDS ATTENTION  "*) name="${row#NEEDS ATTENTION  }"; fix="$(printf '%s\n' "$out" | grep -A1 -F -- "$row" | sed -n '2s/^ *//p')"
          check FAIL "${name%% — *}" "${name#* — } (./alz deps)" "${fix:-./alz deps}" ;;
      esac
    done <<EOF
$out
EOF
  else
    check FAIL "Tools (./alz deps)" "not checked: build dist/ first" "./alz bootstrap, then ./alz deps"
  fi
  if command -v terraform >/dev/null 2>&1; then
    check PASS "terraform on PATH" "$(terraform version 2>/dev/null | sed -n '1p') (the pinned checksum is checked by ./alz deps above)"
  else
    check FAIL "terraform on PATH" "not found" "./alz deps installs the pinned, checksum-verified Terraform"
  fi
  if command -v aws >/dev/null 2>&1; then
    check PASS "AWS CLI" "$(aws --version 2>&1 | sed -n '1p')"
    if [ -z "$PROFILE" ]; then
      check FAIL "Read-only AWS profile" "none named" "pass --readonly-profile NAME: a separate read-only profile for the DEV account (aws configure sso)"
    elif aws configure list-profiles 2>/dev/null | grep -qx -- "$PROFILE"; then
      check PASS "Read-only AWS profile" "$PROFILE (used only by the build preview and ./alz cost status)"
    else
      check FAIL "Read-only AWS profile" "$PROFILE is not a configured profile" "aws configure sso --profile $PROFILE (read-only role in the DEV account)"
    fi
  else
    check FAIL "AWS CLI" "aws is not on PATH" "install AWS CLI v2 (./alz deps shows the pinned version)"
  fi
  detect_script
  if [ "$SCRIPT_KIND" = "none" ]; then check FAIL "script(1)" "not found" "it ships with macOS at /usr/bin/script; restore PATH"; fi

  value="$(fallback_vars)"
  if [ -n "$value" ]; then
    check FAIL "No fallback credentials" "set in this shell: $value" "unset them (unset NAME); the pilot identities refuse them, and the read-only profile is passed only to the read-only steps"
  else
    check PASS "No fallback credentials" "no AWS_PROFILE, static keys or other cloud variables in this shell"
  fi
  if [ -n "${AGENT_SKIP_LOCAL_MODEL+x}" ]; then
    check FAIL "Local models" "AGENT_SKIP_LOCAL_MODEL is set" "unset AGENT_SKIP_LOCAL_MODEL; the build needs the private local models"
  fi

  local contract="config/act-pilot-contract.json" contract_ok=0
  if [ ! -f "$contract" ]; then
    check FAIL "Pilot contract" "$contract is missing" "commit your reviewed limits contract (brief step 3) and run from that commit"
  elif ! git -C "$ROOT" ls-files --error-unmatch "$contract" >/dev/null 2>&1; then
    check FAIL "Pilot contract" "$contract is not committed" "commit it through review (brief step 3); the repository ships none"
  elif ! git -C "$ROOT" diff --quiet HEAD -- "$contract"; then
    check FAIL "Pilot contract" "$contract differs from HEAD" "restore it (git restore $contract) or commit the change through review"
  elif ! read_contract; then
    check FAIL "Pilot contract" "$contract cannot be read" "./alz apply contract-check --file $contract"
  else
    contract_ok=1
    check PASS "Pilot contract" "committed at HEAD, provider $PROVIDER, DEV region ${REGION:-none}"
    if [ "$PROVIDER" != "AWS/TERRAFORM" ]; then check FAIL "Contract path" "the contract names $PROVIDER" "this run is AWS Terraform; use the AWS limits contract"; fi
    if [ "$HAS_LIMITS" = "yes" ]; then
      check PASS "Provisioning limits" "targets.DEV.limits is present"
    else
      check FAIL "Provisioning limits" "targets.DEV names no limits" "start from config/act-pilot-contract.aws-dev-limits.example.json (brief, owner checklist item 2)"
    fi
    case "$ACCOUNT" in
      [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) : ;;
      *) check FAIL "DEV account" "targets.DEV.accountId is not 12 digits" "./alz apply contract-check --file $contract" ;;
    esac
  fi

  if [ "$built" = 1 ] && [ "$contract_ok" = 1 ] && [ "$SCRIPT_KIND" != "none" ]; then
    local rc
    # Read-only and offline; it asks nothing. It gets a terminal from script(1) (the product needs one); only the transcript is
    # read. A person's stdin is passed as it is; without a terminal (a dry run in a pipe) it gets /dev/null.
    if [ -t 0 ]; then in_terminal "$PREFLIGHT_DIR/status.transcript" "$PREFLIGHT_DIR/status.rc" "$ALZ" apply status --environment DEV >/dev/null 2>&1
    else in_terminal "$PREFLIGHT_DIR/status.transcript" "$PREFLIGHT_DIR/status.rc" "$ALZ" apply status --environment DEV </dev/null >/dev/null 2>&1; fi
    rc="$TERMINAL_EXIT"
    value="$(helper pilot-enabled "$PREFLIGHT_DIR/status.transcript" 2>/dev/null)"
    case "$value" in
      PILOT_ENABLED*) check PASS "ACT status for DEV" "./alz apply status: PILOT_ENABLED, DEV authorizes ${value#PILOT_ENABLED }" ;;
      *) check FAIL "ACT status for DEV" "./alz apply status: ${value:-no report} (exit ${rc:-unknown})" "run ./alz apply status --environment DEV; the contract must authorize DEV APPLY (brief step 3)" ;;
    esac
  fi

  if [ -n "$KILL_SWITCH" ] && [ -e "$ROOT/$KILL_SWITCH" ]; then
    check FAIL "Kill switch" "$KILL_SWITCH exists" "review why it was set; only you remove it (rm $KILL_SWITCH)"
  else
    check PASS "Kill switch" "absent (${KILL_SWITCH:-from the contract})"
  fi

  if [ "$built" = 1 ]; then
    value="$(helper cost-config "$ROOT" 2>/dev/null)"
    case "$value" in
      OK) check PASS "config/cost.json" "valid (the product's own validator, src/design/cost.ts)" ;;
      NONE) check FAIL "config/cost.json" "missing" "cp config/cost.example.json config/cost.json and fill it in (git-ignored; never post it)" ;;
      *) check FAIL "config/cost.json" "invalid at: ${value#INVALID }" "fix those fields; the build refuses with COST_CONFIG_INVALID" ;;
    esac
  fi

  missing_tokens=""
  bad=""
  for name in $(identity_vars); do
    eval "value=\${$name-}"
    if [ -z "$value" ]; then bad="$bad $name"; continue; fi
    case "$name" in
      *_ROLE_ARN)
        arn="$value"
        case "$arn" in "arn:aws:iam::$ACCOUNT:role/"*) : ;; *) check FAIL "$name" "does not name a role in the contract's DEV account" "use the role ARN from the bootstrap output role_arns" ;; esac ;;
      *_AWS_REGION)
        region="$value"
        if [ "$region" != "$REGION" ]; then check FAIL "$name" "is $region, the contract's DEV region is $REGION" "export $name=$REGION"; fi ;;
      *_WEB_IDENTITY_TOKEN_FILE)
        token="$value"
        case "$token" in /*) : ;; *) check FAIL "$name" "is not an absolute path" "point it at <root>/aws-terraform/<IDENTITY>.jwt" ; continue ;; esac
        if [ ! -e "$token" ]; then missing_tokens="$missing_tokens ${name#ALZ_}"
        elif ! owner_only "$token"; then check FAIL "$name" "the delivered file is not an owner-only regular file" "check the identity delivery runner (docs/act-pilot-identity-delivery.md)"; fi ;;
    esac
  done
  if [ -n "$bad" ]; then
    check FAIL "Pilot identity variables" "not set:$bad" "export the twelve ALZ_* variables (brief, 'Verified role ARNs and identity-delivery configuration')"
  else
    check PASS "Pilot identity variables" "all twelve set (names checked only; no token is read)"
  fi
  if [ -n "$missing_tokens" ]; then
    check WAIT "Delivered identity tokens" "not present yet:$missing_tokens" "start the identity delivery before the qualify step; the runner stops there until they exist"
  elif [ -z "$bad" ]; then
    check PASS "Delivered identity tokens" "present and owner-only (not opened)"
  fi

  if [ -z "$REQUESTER" ]; then
    case "$APPROVER_IDS" in
      *,*|"") ;;
      *) REQUESTER="$APPROVER_IDS" ;;
    esac
  fi
  [ -n "$APPROVER" ] || APPROVER="$REQUESTER"
  [ -n "$APPROVER_KEY" ] || APPROVER_KEY="$REQUESTER_KEY"
  if [ -z "$REQUESTER" ]; then
    check FAIL "Requester id" "the contract lists ${APPROVER_IDS:-no} approver ids" "pass --requester ID (and --approver ID) from the contract's approvers"
  else
    case ",$APPROVER_IDS," in
      *",$REQUESTER,"*) check PASS "Requester id" "$REQUESTER (approver $APPROVER)" ;;
      *) check FAIL "Requester id" "$REQUESTER is not on the contract's allowlist" "use an id from the contract's approvers[]" ;;
    esac
  fi
  if keys_needed; then
    for name in REQUESTER_KEY APPROVER_KEY; do
      eval "value=\$$name"
      if [ -z "$value" ]; then
        check FAIL "${name%_KEY} key file" "not named" "pass --$(printf '%s' "${name%_KEY}" | tr 'A-Z' 'a-z')-key /path/to/key.pem"
      elif owner_only "$value"; then
        check PASS "${name%_KEY} key file" "owner-only regular file (not opened by this script)"
      else
        check FAIL "${name%_KEY} key file" "missing, a link, or readable by others" "chmod 600 <key file>; the product refuses any other mode"
      fi
    done
  fi

  if [ -n "$REFUSED_DIR" ]; then
    case "$REFUSED_DIR" in
      "$ROOT"|"$ROOT"/*) check FAIL "Refused example" "the canary copy is inside the checkout" "copy qualification/aws/act-dev1-canary to a folder outside the checkout" ;;
      /*)
        if [ ! -f "$REFUSED_DIR/main.tf" ]; then
          check FAIL "Refused example" "$REFUSED_DIR has no main.tf" "cp -R qualification/aws/act-dev1-canary <folder outside the checkout>"
        elif [ ! -f "$REFUSED_DIR/terraform.tfvars.json" ] || grep -q "REPLACE-WITH-APPROVED-OWNER" "$REFUSED_DIR/terraform.tfvars.json"; then
          check FAIL "Refused example" "terraform.tfvars.json is missing or keeps the owner placeholder" "create it from terraform.tfvars.example.json with your region, canary_name and owner"
        else
          check PASS "Refused example" "opted in: $REFUSED_DIR (a live, read-only DISCOVERY plan; expected RESOURCE_NOT_IN_LIMITS)"
        fi ;;
      *) check FAIL "Refused example" "the folder must be an absolute path" "pass --refused-example /absolute/path" ;;
    esac
  else
    check INFO "Refused example" "not selected (item 6's refused half stays NEEDS_OWNER_CHECK)"
  fi

  if [ "$DRY_RUN" = 0 ]; then
    if [ -t 0 ] && [ -t 1 ]; then
      check PASS "Interactive terminal" "stdin and stdout are a terminal; you type every phrase"
    else
      check FAIL "Interactive terminal" "stdin or stdout is not a terminal" "run it in Terminal.app; the script never runs a human gate without a person"
    fi
  fi
  check INFO "Network" "no documentation site (docs.aws.amazon.com) is needed; only the product's own tool and AWS calls use the network"
  check INFO "D4 identity proof" "planned on the MacBook Pro runner; if this Mac Mini is the execution host, repeat it here first (docs/act-pilot-identity-delivery.md, section 11)"
  check INFO "Disposition" "RETAIN: this script never proposes or runs a cleanup"

  say "Preflight checklist"
  rule
  printf '%s' "$CHECKLIST"
  rule
  if [ "$FAILS" -gt 0 ]; then
    say "PREFLIGHT FAILED: $FAILS item(s) above need a fix. Nothing was run against the cloud."
    return 1
  fi
  say "Preflight passed."
  return 0
}

# --- the run ---------------------------------------------------------------------------------------------

RUN=""
RUN_ID=""
values_set() {
  local key="$1" value="$2" file="$RUN/values"
  case "$value" in *$'\n'*) say "internal: refusing a multi-line value for $key" >&2; return 1 ;; esac
  printf '%s=%s\n' "$key" "$value" >> "$file"
}
val() { kv "$RUN/values" "$1"; }
step_done() { [ -f "$RUN/steps/$1.done" ]; }
step_env() { printf '%s/steps/%s.env' "$RUN" "$1"; }
step_record() { printf '%s=%s\n' "$2" "$3" >> "$(step_env "$1")"; }
# attempts ENV: how many times the step started (a missing file, or one without a STARTED line, is 0). Counted in the shell, so
# the result is always one integer (review N5: `grep -c ... || printf 0` gave "0<newline>0" for a file with no STARTED line).
attempts() {
  local n=0 line
  [ -f "$1" ] || { printf '0'; return 0; }
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in STARTED=*) n=$((n + 1)) ;; esac
  done < "$1"
  printf '%s' "$n"
}
# latest_exit ENV: the EXIT recorded after the latest STARTED, or nothing when that attempt never recorded one (an interrupted
# attempt). An EXIT of an earlier attempt never counts for a later start (review N1).
latest_exit() {
  local value="" line
  [ -f "$1" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      STARTED=*) value="" ;;
      EXIT=*) value="${line#EXIT=}" ;;
    esac
  done < "$1"
  printf '%s' "$value"
}

keys_needed() {
  [ -z "$RUN" ] && return 0
  local s steps="08-seal 09-approve"
  [ -n "$REFUSED_DIR" ] && steps="$steps 17-refused-seal"
  for s in $steps; do step_done "$s" || return 0; done
  return 1
}

# display ARGS...: the command as shown and journaled: relative ./alz, key files as labels, never a secret.
display() {
  local out="" arg
  for arg in "$@"; do
    case "$arg" in
      "$ALZ") arg="./alz" ;;
      readonly_env) arg="AWS_PROFILE=$PROFILE [pilot ALZ_* identities removed]" ;;
      "$REQUESTER_KEY") [ -n "$REQUESTER_KEY" ] && arg="<REQUESTER_KEY.pem>" ;;
      "$APPROVER_KEY") [ -n "$APPROVER_KEY" ] && arg="<APPROVER_KEY.pem>" ;;
    esac
    out="$out $arg"
  done
  printf '%s' "${out# }"
}

# stop STEP MESSAGE NEXT: the run stops here, with the next action.
stop() {
  rule
  say "STOPPED at $1: $2"
  say "Next: $3"
  say "Run state: ${RUN#"$ROOT"/} (owner-only). Resume with: scripts/mac-acceptance.sh --resume [same options]"
  say "Partial evidence bundle: scripts/mac-acceptance.sh --bundle [same options]"
  exit 1
}

# terminal_step NAME GATE_TEXT CMD...: shows the command, hands the person's terminal to it, journals the result.
LAST_EXIT=""
LAST_TRANSCRIPT=""
terminal_step() {
  local name="$1" gate="$2" attempt env
  shift 2
  env="$(step_env "$name")"
  attempt=$(( $(attempts "$env") + 1 ))
  LAST_TRANSCRIPT="$RUN/out/$name.$attempt.transcript"
  rule
  say "STEP $name (attempt $attempt)"
  say "  \$ $(display "$@")"
  if [ -n "$gate" ]; then say "  Human gate: $gate"; say "  The script types nothing: read the screen, then answer the product yourself."; fi
  step_record "$name" STARTED "$(now)"
  step_record "$name" COMMAND "$(display "$@")"
  step_record "$name" TRANSCRIPT "$LAST_TRANSCRIPT"
  in_terminal "$LAST_TRANSCRIPT" "$RUN/out/$name.rc" "$@"
  LAST_EXIT="$TERMINAL_EXIT"
  step_record "$name" EXIT "$LAST_EXIT"
  step_record "$name" FINISHED "$(now)"
  step_record "$name" TRANSCRIPT_SHA256 "$(helper sha256 "$LAST_TRANSCRIPT" 2>/dev/null)"
  say "  exit $LAST_EXIT"
}

# captured_step NAME CMD...: a non-interactive, read-only step: stdout and stderr kept apart, shown when it ends (quiet by default).
LAST_OUT=""
LAST_ERR=""
captured_step() {
  local name="$1" attempt env
  shift
  env="$(step_env "$name")"
  attempt=$(( $(attempts "$env") + 1 ))
  LAST_OUT="$RUN/out/$name.$attempt.stdout"
  LAST_ERR="$RUN/out/$name.$attempt.stderr"
  rule
  say "STEP $name (attempt $attempt)"
  say "  \$ $(display "$@")"
  step_record "$name" STARTED "$(now)"
  step_record "$name" COMMAND "$(display "$@")"
  step_record "$name" STDOUT "$LAST_OUT"
  step_record "$name" STDERR "$LAST_ERR"
  "$@" > "$LAST_OUT" 2> "$LAST_ERR"
  LAST_EXIT=$?
  step_record "$name" EXIT "$LAST_EXIT"
  step_record "$name" FINISHED "$(now)"
  step_record "$name" STDOUT_SHA256 "$(helper sha256 "$LAST_OUT" 2>/dev/null)"
  step_record "$name" STDERR_SHA256 "$(helper sha256 "$LAST_ERR" 2>/dev/null)"
  say "  exit $LAST_EXIT"
}

internal_step() {
  rule
  say "STEP $1"
  say "  $2"
  step_record "$1" STARTED "$(now)"
  step_record "$1" COMMAND "$2"
}
finish_step() { step_record "$1" FINISHED "$(now)"; : > "$RUN/steps/$1.done"; }
skip_note() { say "STEP $1: done at $(kv "$(step_env "$1")" FINISHED), skipped"; }

tokens_ready() {
  local id file
  for id in $IDENTITIES; do
    eval "file=\${ALZ_${id}_AWS_WEB_IDENTITY_TOKEN_FILE-}"
    owner_only "$file" || return 1
  done
}
need_tokens() {
  tokens_ready || stop "$1" "the delivered identity tokens are not all present" \
    "start or refresh the identity delivery (brief step 1; docs/act-pilot-identity-delivery.md), then run --resume"
}
need_terminal() {
  if [ ! -t 0 ] || [ ! -t 1 ]; then stop "$1" "no interactive terminal" "run the script in Terminal.app; a human gate never runs without a person"; fi
}

# prepare_twice KEY FIRST TAGS SECOND PROJECT: brief owner checklist item 4 (prepare, copy the printed unit tags into unit_tags,
# prepare again, and use the files of the second run). KEY prefixes the values the later steps read.
prepare_twice() {
  local key="$1" first="$2" fill="$3" second="$4" project="$5" out tags unit
  if ! step_done "$first"; then
    need_terminal "$first"
    terminal_step "$first" "" "$ALZ" apply prepare --environment DEV --project "$project"
    [ "$LAST_EXIT" = 0 ] || stop "$first" "prepare exited $LAST_EXIT" "read the BLOCKED code above (it names an owner prerequisite), fix it, then --resume"
    out="$(helper prepared "$LAST_TRANSCRIPT" 2>&1)" || stop "$first" "the preparation record could not be read ($out)" "check the transcript, then --resume"
    values_set "${key}_UNIT_TAGS_1" "$(printf '%s\n' "$out" | sed -n 's/^UNIT_TAGS=//p')"
    finish_step "$first"
  else skip_note "$first"; fi
  if ! step_done "$fill"; then
    tags="$(val "${key}_UNIT_TAGS_1")"
    internal_step "$fill" "write the three unit tags prepare printed into unit_tags in $project/terraform.tfvars.json"
    helper fill-tags "$project" "$tags" || stop "$fill" "the unit tags could not be written" "copy them by hand into unit_tags, then --resume"
    finish_step "$fill"
  else skip_note "$fill"; fi
  if ! step_done "$second"; then
    need_terminal "$second"
    terminal_step "$second" "" "$ALZ" apply prepare --environment DEV --project "$project"
    [ "$LAST_EXIT" = 0 ] || stop "$second" "prepare exited $LAST_EXIT" "read the BLOCKED code above, fix it, then --resume"
    out="$(helper prepared "$LAST_TRANSCRIPT" 2>&1)" || stop "$second" "the preparation record could not be read ($out)" "check the transcript, then --resume"
    tags="$(printf '%s\n' "$out" | sed -n 's/^UNIT_TAGS=//p')"
    [ "$tags" = "$(val "${key}_UNIT_TAGS_1")" ] || stop "$second" "the second prepare printed different unit tags" "the contract or the project changed between the two runs; review it before anything else"
    unit="$(printf '%s\n' "$out" | sed -n 's/^UNIT_ID=//p')"
    values_set "${key}_REQUEST" "$(printf '%s\n' "$out" | sed -n 's/^REQUEST=//p')"
    values_set "${key}_APPLY_REQUEST" "$(printf '%s\n' "$out" | sed -n 's/^APPLY_REQUEST=//p')"
    values_set "${key}_MANIFEST" "$(printf '%s\n' "$out" | sed -n 's/^MANIFEST=//p')"
    values_set "${key}_UNIT_ID" "$unit"
    say "  Unit tags bound by the second prepare (deletion unit $unit): $tags"
    finish_step "$second"
  else skip_note "$second"; fi
}

run_steps() {
  local project out sealed bundle artifact approval unit

  # 01 build: the cost-baseline project (brief owner checklist item 3), with the read-only profile and no pilot identity.
  if ! step_done 01-build; then
    captured_step 01-build readonly_env ALZ_ALLOW_REAL_PRIVATE_BUILD=1 ALZ_ALLOW_TERRAFORM_PLAN=1 TF_VAR_aws_region="$REGION" \
      node dist/cli/real-private-build.js --live-aws-read-only --scenario cost-baseline
    tail -n 15 "$LAST_OUT"
    if [ "$LAST_EXIT" != 0 ]; then
      tail -n 15 "$LAST_ERR" >&2
      stop 01-build "the build exited $LAST_EXIT" "read the code above (COST_CONFIG_*, SOURCE_WORKTREE_DIRTY, a model or preview gate); full output in ${LAST_OUT#"$ROOT"/} and ${LAST_ERR#"$ROOT"/}"
    fi
    project="$(sed -n 's/^Pilot project ([^)]*): //p' "$LAST_OUT" | tail -n 1)"
    case "$project" in
      "$ROOT"/.runs/qualification/real-private-build/*/project) [ -d "$project" ] || project="" ;;
      *) project="" ;;
    esac
    [ -n "$project" ] || stop 01-build "the build did not print its project folder" "check ${LAST_OUT#"$ROOT"/}; the project is written only when every gate passes"
    values_set PROJECT "$project"
    finish_step 01-build
  else skip_note 01-build; fi
  project="$(val PROJECT)"

  if ! step_done 02-tfvars; then
    internal_step 02-tfvars "copy terraform.tfvars.example.json to terraform.tfvars.json in the project (only when it is not there yet)"
    if [ ! -f "$project/terraform.tfvars.json" ]; then cp "$project/terraform.tfvars.example.json" "$project/terraform.tfvars.json" || stop 02-tfvars "the copy failed" "copy it by hand, then --resume"; fi
    finish_step 02-tfvars
  else skip_note 02-tfvars; fi

  prepare_twice COST 03-prepare-1 04-unit-tags 05-prepare-2 "$project"

  if ! step_done 06-qualify; then
    need_terminal 06-qualify; need_tokens 06-qualify
    terminal_step 06-qualify "the target, RUN PROJECT CODE and EMBED STATE_WRITE DEV; then SEPARATED <STATE_WRITE role ARN> <APPLY role ARN>, only if CloudTrail shows state access by STATE_WRITE (and STATE) only" \
      "$ALZ" apply qualify --request "$(val COST_REQUEST)" --manifest "$(val COST_MANIFEST)"
    [ "$LAST_EXIT" = 0 ] || stop 06-qualify "qualify exited $LAST_EXIT" "read the code above (brief step 4, Stop); fix the cause, never weaken a check, then --resume"
    finish_step 06-qualify
  else skip_note 06-qualify; fi

  if ! step_done 07-preflight; then
    need_terminal 07-preflight
    terminal_step 07-preflight "" "$ALZ" apply preflight --environment DEV
    [ "$LAST_EXIT" = 0 ] || stop 07-preflight "preflight exited $LAST_EXIT (not ready)" "read the items that are not READY above, fix them, then --resume"
    finish_step 07-preflight
  else skip_note 07-preflight; fi

  if ! step_done 08-seal; then
    need_terminal 08-seal; need_tokens 08-seal
    terminal_step 08-seal "the target, RUN PROJECT CODE and EMBED STATE_WRITE DEV" \
      "$ALZ" apply seal --request "$(val COST_REQUEST)" --manifest "$(val COST_MANIFEST)" --requester "$REQUESTER" --key "$REQUESTER_KEY"
    [ "$LAST_EXIT" = 0 ] || stop 08-seal "seal exited $LAST_EXIT" "read the code above (RESOURCE_NOT_IN_LIMITS, a unit tag, ENGINE_NOT_QUALIFIED); nothing was sealed or approved; fix the cause, then --resume"
    out="$(helper sealed "$LAST_TRANSCRIPT" 2>&1)" || stop 08-seal "the seal's result could not be read ($out)" "check the transcript, then --resume"
    values_set SEALED "$(printf '%s\n' "$out" | sed -n 's/^SEALED=//p')"
    values_set REVIEW_BUNDLE "$(printf '%s\n' "$out" | sed -n 's/^REVIEW_BUNDLE=//p')"
    values_set ARTIFACT "$(printf '%s\n' "$out" | sed -n 's/^ARTIFACT=//p')"
    say "  Review the change list above before you approve: only admitted types, counts and regions (us-east-2 and us-east-1),"
    say "  and the unit tags prepare printed. If anything else shows, do not approve (brief step 5, Stop)."
    finish_step 08-seal
  else skip_note 08-seal; fi
  sealed="$(val SEALED)"; bundle="$(val REVIEW_BUNDLE)"; artifact="$(val ARTIFACT)"
  approval="$RUN/approval-apply.json"

  if ! step_done 09-approve; then
    need_terminal 09-approve
    if [ -f "$approval" ] && helper approval "$approval" "$artifact" "$RUN/out/approval-check.json" >/dev/null 2>&1; then
      internal_step 09-approve "use the signed approval already saved at ${approval#"$ROOT"/}"
      finish_step 09-approve
    else
      terminal_step 09-approve "APPROVE DEV <first 12 characters of the artifact hash>, after you review the changes it shows" \
        "$ALZ" apply approve --bundle "$bundle" --key "$APPROVER_KEY" --approver "$APPROVER"
      [ "$LAST_EXIT" = 0 ] || stop 09-approve "approve exited $LAST_EXIT; nothing was signed" "read the code above; then --resume"
      out="$(helper approval "$LAST_TRANSCRIPT" "$artifact" "$approval" 2>/dev/null)"
      case "$out" in
        SAVED*) say "  The signed approval the product printed (no secret) is saved for apply: ${approval#"$ROOT"/}. It is valid for the contract's maxApprovalAgeMinutes; apply soon." ;;
        *) stop 09-approve "the signed approval could not be found in the output" "save the approval JSON printed above as ${approval#"$ROOT"/} (mode 0600), then --resume" ;;
      esac
      finish_step 09-approve
    fi
  else skip_note 09-approve; fi

  if ! step_done 10-apply; then
    # A retry only after an attempt whose own recorded exit is 2 (BLOCKED, nothing spent). An attempt with no recorded exit (the
    # session died mid-apply) or any other exit is never retried here (review N1).
    local previous started
    started="$(attempts "$(step_env 10-apply)")"
    previous="$(latest_exit "$(step_env 10-apply)")"
    if [ "$started" -gt 0 ] && [ "$previous" != 2 ]; then
      stop 10-apply "an apply of this sealed plan was already attempted (latest attempt: exit ${previous:-not recorded})" \
        "do not retry. Follow 'When an apply fails' in docs/act-pilot-apply.md; a retry is always a new seal with new approvals (a new run)"
    fi
    need_terminal 10-apply; need_tokens 10-apply
    terminal_step 10-apply "one line: APPLY DEV <first 12 characters> <account> | <backend> | <workspace>. Watch CloudTrail during the apply" \
      "$ALZ" apply apply --request "$(val COST_APPLY_REQUEST)" --manifest "$(val COST_MANIFEST)" --sealed "$sealed" --approval "$approval"
    case "$LAST_EXIT" in
      0) finish_step 10-apply ;;
      2) stop 10-apply "apply was BLOCKED (exit 2); nothing was spent" "read the code above, fix it, then --resume (an expired approval needs a new approve: delete ${approval#"$ROOT"/} and remove ${RUN#"$ROOT"/}/steps/09-approve.done first)" ;;
      3) stop 10-apply "apply ended SPENT (exit 3)" "do not retry. Follow 'When an apply fails' in docs/act-pilot-apply.md and record what you saw on #39 without sensitive values" ;;
      *) stop 10-apply "apply exited $LAST_EXIT" "read the message above before anything else; do not retry the same files. A mistyped APPLY line (APPLY_CONFIRMATION_MISMATCH) also ends this run: recover with a new seal and new approvals in a new run (docs/mac-acceptance-runner.md, 'If the APPLY line was mistyped')" ;;
    esac
  else skip_note 10-apply; fi

  if ! step_done 11-apply-status; then
    need_terminal 11-apply-status
    terminal_step 11-apply-status "" "$ALZ" apply status --sealed "$sealed"
    [ "$LAST_EXIT" = 0 ] || stop 11-apply-status "status exited $LAST_EXIT" "read the message above, then --resume"
    finish_step 11-apply-status
  else skip_note 11-apply-status; fi

  if ! step_done 12-observe; then
    need_terminal 12-observe; need_tokens 12-observe
    terminal_step 12-observe "" "$ALZ" apply observe --sealed "$sealed"
    [ "$LAST_EXIT" = 0 ] || stop 12-observe "observe exited $LAST_EXIT" "read the code above; observe is read-only and repeatable: --resume"
    if [ -f "$ROOT/.runs/apply/reports/$(printf '%s' "$artifact" | cut -c1-12)-observation.json" ]; then
      cp "$ROOT/.runs/apply/reports/$(printf '%s' "$artifact" | cut -c1-12)-observation.json" "$RUN/observation-summary.json"
    fi
    say "  For this payload: the bucket, topic and export should be VERIFIED and every unmapped type UNVERIFIABLE (brief, 'Expected results')."
    finish_step 12-observe
  else skip_note 12-observe; fi

  if ! step_done 13-cost-status; then
    unit="$(val COST_UNIT_ID)"
    captured_step 13-cost-status readonly_env "$ALZ" cost status --account "$ACCOUNT" --unit "$unit" --region "$REGION"
    cat "$LAST_OUT"
    if [ "$LAST_EXIT" != 0 ]; then
      cat "$LAST_ERR" >&2
      stop 13-cost-status "cost status exited $LAST_EXIT" "check the read-only profile's sign-in (aws sso login --profile $PROFILE), then --resume"
    fi
    say "  On day one overall is expected to read INCOMPLETE, the export and freshness WAITING (brief, 'Cost status on day one')."
    finish_step 13-cost-status
  else skip_note 13-cost-status; fi

  if [ -n "$REFUSED_DIR" ]; then
    prepare_twice CANARY 14-refused-prepare-1 15-refused-unit-tags 16-refused-prepare-2 "$REFUSED_DIR"
    if ! step_done 17-refused-seal; then
      need_terminal 17-refused-seal; need_tokens 17-refused-seal
      say "  Acceptance item 6, refused example: a live, read-only DISCOVERY plan of the log-group canary copy, expected to stop with"
      say "  RESOURCE_NOT_IN_LIMITS before anything is sealed or any approval is consumed."
      terminal_step 17-refused-seal "the target, RUN PROJECT CODE and EMBED STATE_WRITE DEV (expected to be refused after the plan)" \
        "$ALZ" apply seal --request "$(val CANARY_REQUEST)" --manifest "$(val CANARY_MANIFEST)" --requester "$REQUESTER" --key "$REQUESTER_KEY"
      out="$(helper refusal "$LAST_TRANSCRIPT" 2>/dev/null)"
      step_record 17-refused-seal REFUSAL "$out"
      case "$LAST_EXIT" in
        0) stop 17-refused-seal "the seal of the canary copy SUCCEEDED: the limits admitted a log group" "do not approve that plan. Review the contract's limits with the coordinator before anything else" ;;
        2) say "  Refused as recorded: ${out:-no code read} (item 6 is OBSERVED only for RESOURCE_NOT_IN_LIMITS)."; finish_step 17-refused-seal ;;
        *) stop 17-refused-seal "the seal exited $LAST_EXIT" "read the message above, then --resume" ;;
      esac
    else skip_note 17-refused-seal; fi
  fi
}

# --- the evidence bundle -----------------------------------------------------------------------------------

write_bundle() {
  local b="$RUN/bundle" file name masks archive count
  rm -rf "$b"
  helper mkdir-private "$b" && helper mkdir-private "$b/steps" && helper mkdir-private "$b/output" || { say "Cannot create the bundle folder." >&2; return 1; }
  masks=()
  # Absolute paths: the checkout, the canary copy and the home folder become labels (review N6); the helper also replaces any
  # remaining /Users/<name>/ or /home/<name>/ segment.
  masks+=( "$ROOT" "<REPO>" )
  [ -n "$REFUSED_DIR" ] && masks+=( "$REFUSED_DIR" "<CANARY_COPY>" )
  [ -n "$HOME" ] && [ "$HOME" != "/" ] && masks+=( "$HOME" "<HOME>" )
  [ -n "$STATE_BUCKET" ] && masks+=( "$STATE_BUCKET" "<STATE_BUCKET>" )
  [ -n "$REQUESTER_KEY" ] && masks+=( "$REQUESTER_KEY" "<REQUESTER_KEY.pem>" )
  [ -n "$APPROVER_KEY" ] && masks+=( "$APPROVER_KEY" "<APPROVER_KEY.pem>" )
  for file in "$RUN"/steps/*.env; do
    [ -f "$file" ] || continue
    helper redact "$ROOT" "$file" "$b/steps/$(basename "$file")" "$ACCOUNT" "$KEEP_ACCOUNT" "${masks[@]}" || return 1
  done
  for file in "$RUN"/out/*.transcript "$RUN"/out/*.stdout "$RUN"/out/*.stderr; do
    [ -f "$file" ] || continue
    name="$(basename "$file")"
    helper redact "$ROOT" "$file" "$b/output/$name.txt" "$ACCOUNT" "$KEEP_ACCOUNT" "${masks[@]}" || return 1
  done
  [ -f "$RUN/preflight.txt" ] && helper redact "$ROOT" "$RUN/preflight.txt" "$b/preflight.txt" "$ACCOUNT" "$KEEP_ACCOUNT" "${masks[@]}"
  if step_done 13-cost-status; then
    helper cost "$ROOT" "$b/cost-status.redacted.json" "$ACCOUNT" "$KEEP_ACCOUNT" "${masks[@]}" >/dev/null || say "  The saved cost status could not be read; items 1 to 8 that need it stay UNKNOWN."
  fi
  if step_done 08-seal && [ -f "$(val REVIEW_BUNDLE)" ]; then helper review "$(val REVIEW_BUNDLE)" "$b/review-bundle.json" "$ACCOUNT" "$KEEP_ACCOUNT" "${masks[@]}"; fi
  [ -f "$RUN/observation-summary.json" ] && helper redact "$ROOT" "$RUN/observation-summary.json" "$b/observation-summary.json" "$ACCOUNT" "$KEEP_ACCOUNT" "${masks[@]}"
  say "Acceptance items (see acceptance-report.md):"
  helper report "$RUN" "$b" || return 1
  if ! helper scan "$b" "$KEEP_ACCOUNT"; then
    rm -rf "$b"
    say "BUNDLE REFUSED: secret-looking text was found (named above by file and kind only). Nothing was archived." >&2
    return 1
  fi
  count="$(helper manifest "$b")" || return 1
  archive="$RUN/acceptance-bundle-$RUN_ID.tar.gz"
  rm -f "$archive" "$archive.sha256"
  tar -czf "$archive" -C "$RUN" bundle || return 1
  chmod 600 "$archive"
  printf '%s  %s\n' "$(helper sha256 "$archive")" "$(basename "$archive")" > "$archive.sha256"
  rule
  say "Evidence bundle (owner-only; LIVE evidence collected by you on this host, not CI or agent-collected):"
  say "  folder    ${b#"$ROOT"/} ($count files, MANIFEST.sha256 inside)"
  say "  archive   ${archive#"$ROOT"/}"
  say "  checksum  ${archive#"$ROOT"/}.sha256"
  say "  report    ${b#"$ROOT"/}/acceptance-report.md"
  say "Review the report before sharing anything. It does not by itself certify acceptance."
}

retention_note() {
  rule
  say "RETENTION: the disposition is RETAIN (owner decision record 6646346513). The cost baseline stays deployed; this script"
  say "never proposes or runs a cleanup. Teardown needs a separate, explicit disposition and the brief's cleanup step, run by you."
}

print_plan() {
  local project="<COST_PROJECT>" req="<REQUEST.json>" areq="<APPLY_REQUEST.json>" man="<MANIFEST.json>" sealed="<SEALED_PLAN>"
  local rk="<REQUESTER_KEY.pem>" ak="<APPROVER_KEY.pem>"
  say ""
  say "Planned steps (dry run: nothing below runs, no run state is written):"
  say "  01-build          AWS_PROFILE=${PROFILE:-<READONLY_PROFILE>} (pilot ALZ_* identities removed) ALZ_ALLOW_REAL_PRIVATE_BUILD=1 ALZ_ALLOW_TERRAFORM_PLAN=1 TF_VAR_aws_region=${REGION:-<HOME_REGION>} node dist/cli/real-private-build.js --live-aws-read-only --scenario cost-baseline"
  say "  02-tfvars         copy $project/terraform.tfvars.example.json to terraform.tfvars.json (if missing)"
  say "  03-prepare-1     ./alz apply prepare --environment DEV --project $project"
  say "  04-unit-tags      write the printed unit tags into unit_tags in $project/terraform.tfvars.json"
  say "  05-prepare-2      ./alz apply prepare --environment DEV --project $project"
  say "  06-qualify        ./alz apply qualify --request $req --manifest $man                         [you type the phrases]"
  say "  07-preflight      ./alz apply preflight --environment DEV"
  say "  08-seal           ./alz apply seal --request $req --manifest $man --requester ${REQUESTER:-<ID>} --key $rk   [you type the phrases]"
  say "  09-approve        ./alz apply approve --bundle <REVIEW_BUNDLE.json> --key $ak --approver ${APPROVER:-<ID>}   [you type APPROVE DEV ...]"
  say "  10-apply          ./alz apply apply --request $areq --manifest $man --sealed $sealed --approval <APPROVAL.json>   [you type APPLY DEV ...]"
  say "  11-apply-status   ./alz apply status --sealed $sealed"
  say "  12-observe        ./alz apply observe --sealed $sealed"
  say "  13-cost-status    AWS_PROFILE=${PROFILE:-<READONLY_PROFILE>} ./alz cost status --account ${ACCOUNT:-<DEV_ACCOUNT_ID>} --unit <UNIT_ID> --region ${REGION:-<HOME_REGION>}"
  if [ -n "$REFUSED_DIR" ]; then
    say "  14-16 refused     ./alz apply prepare --environment DEV --project $REFUSED_DIR (twice, unit tags written between)"
    say "  17-refused-seal   ./alz apply seal --request <CANARY_REQUEST.json> --manifest <CANARY_MANIFEST.json> --requester ${REQUESTER:-<ID>} --key $rk   [expected: RESOURCE_NOT_IN_LIMITS]"
  fi
  say "  bundle            owner-only folder, tar.gz and SHA-256 manifest under .runs/mac-acceptance/<run>/, with acceptance-report.md"
  say "No step proposes or runs a cleanup (disposition RETAIN)."
}

# --- the single-run lock (review N3) -------------------------------------------------------------------------

# One runner at a time, for every mode that writes run state (a run, --resume, --bundle). mkdir is atomic: exactly one process
# creates .runs/mac-acceptance/lock, and it writes its pid there. A lock whose pid is a live process is never broken. A lock
# whose pid is gone is stale: it is moved aside (rename is atomic, so only one process can take it) and taken again once.
LOCK="$BASE/lock"
LOCK_OWNED=0
release_lock() {
  if [ "$LOCK_OWNED" = 1 ] && [ "$(sed -n '1p' "$LOCK/pid" 2>/dev/null)" = "$$" ]; then rm -rf "$LOCK"; fi
  LOCK_OWNED=0
}
take_lock() {
  local holder round
  { mkdir -p "$BASE" && chmod 700 "$BASE"; } || { echo "mac-acceptance: cannot create ${BASE#"$ROOT"/}" >&2; exit 2; }
  for round in 1 2; do
    if mkdir "$LOCK" 2>/dev/null; then
      printf '%s\n%s\n' "$$" "$(now)" > "$LOCK/pid"
      LOCK_OWNED=1
      trap release_lock EXIT
      return 0
    fi
    holder="$(sed -n '1p' "$LOCK/pid" 2>/dev/null)"
    case "$holder" in
      ""|*[!0-9]*)
        echo "mac-acceptance: another runner holds ${LOCK#"$ROOT"/} (no pid recorded yet, or it is unreadable)." >&2
        echo "If you are sure no runner is running, review it and remove that folder by hand." >&2
        exit 2 ;;
    esac
    if ps -p "$holder" >/dev/null 2>&1; then
      echo "mac-acceptance: another runner (pid $holder) is running this acceptance run. Wait for it; the lock is never broken while it runs." >&2
      exit 2
    fi
    if [ "$round" = 1 ] && mv "$LOCK" "$LOCK.stale.$$" 2>/dev/null; then
      echo "mac-acceptance: removed a stale lock (pid $holder is no longer running)." >&2
      rm -rf "$LOCK.stale.$$"
    fi
  done
  echo "mac-acceptance: could not take ${LOCK#"$ROOT"/}; another runner may have just started. Try again." >&2
  exit 2
}

# runner_digest: the SHA-256 of this script and its helper, recorded at the start of a run.
runner_digest() { printf '%s %s' "$(helper sha256 "$ROOT/scripts/mac-acceptance.sh" 2>/dev/null)" "$(helper sha256 "$HELPER" 2>/dev/null)"; }

# --- main --------------------------------------------------------------------------------------------------

[ "$DRY_RUN" = 1 ] || take_lock

if [ "$RESUME" = 1 ] || [ "$BUNDLE_ONLY" = 1 ]; then
  if [ ! -f "$BASE/current" ]; then echo "mac-acceptance: no run to resume (no .runs/mac-acceptance/current); start one without --resume" >&2; exit 2; fi
  RUN_ID="$(sed -n '1p' "$BASE/current")"
  case "$RUN_ID" in run-[0-9]*) : ;; *) echo "mac-acceptance: .runs/mac-acceptance/current names no run" >&2; exit 2 ;; esac
  RUN="$BASE/$RUN_ID"
  [ -d "$RUN" ] || { echo "mac-acceptance: the run folder $RUN_ID is missing" >&2; exit 2; }
  [ -n "$PROFILE" ] || PROFILE="$(val PROFILE)"
  [ -n "$REQUESTER" ] || REQUESTER="$(val REQUESTER)"
  [ -n "$APPROVER" ] || APPROVER="$(val APPROVER)"
  [ -n "$REFUSED_DIR" ] || REFUSED_DIR="$(val REFUSED_DIR)"
  [ "$KEEP_ACCOUNT" = yes ] || KEEP_ACCOUNT="$(val KEEP_ACCOUNT)"
  [ -n "$KEEP_ACCOUNT" ] || KEEP_ACCOUNT=no
  # The runner must not change during an acceptance run: its evidence names one runner (docs/mac-acceptance-runner.md).
  if [ -n "$(val RUNNER_SHA256)" ] && [ "$(runner_digest)" != "$(val RUNNER_SHA256)" ]; then
    echo "mac-acceptance: the runner changed since this run started (scripts/mac-acceptance.sh or its helper)." >&2
    echo "Do not update the runner during an active acceptance run. Restore the recorded commit ($(val COMMIT)), or finish this run's" >&2
    echo "evidence with that runner; a later runner fix needs an evidence-impact note (docs/mac-acceptance-runner.md)." >&2
    exit 2
  fi
elif [ "$DRY_RUN" = 0 ] && [ -f "$BASE/current" ]; then
  echo "mac-acceptance: a run is already in progress ($(sed -n '1p' "$BASE/current")). Continue it with --resume." >&2
  echo "A second run would seal and apply again; start one only after review, by moving .runs/mac-acceptance/current aside." >&2
  exit 2
fi

if [ "$BUNDLE_ONLY" = 1 ]; then
  read_contract || true
  # Mask with the run's own recorded target, whatever the contract reads now (review N4).
  [ -z "$(val ACCOUNT)" ] || ACCOUNT="$(val ACCOUNT)"
  [ -z "$(val STATE_BUCKET)" ] || STATE_BUCKET="$(val STATE_BUCKET)"
  if [ -z "$ACCOUNT" ] && [ "$KEEP_ACCOUNT" != yes ]; then
    echo "mac-acceptance: the run's account is unknown (no recorded target and no readable contract), so it cannot be masked." >&2
    echo "Nothing was bundled. Restore config/act-pilot-contract.json at the run's commit, or pass --include-account-id to keep it." >&2
    exit 2
  fi
  write_bundle || exit 1
  retention_note
  exit 0
fi

say "Mac acceptance runner: AWS cost baseline, first supervised DEV run (the script answers no prompt and authorizes nothing)"
if ! preflight; then rm -rf "$PREFLIGHT_DIR"; exit 2; fi
if [ "$DRY_RUN" = 1 ]; then
  print_plan
  rm -rf "$PREFLIGHT_DIR"
  exit 0
fi

if [ -z "$RUN" ]; then
  helper mkdir-private "$BASE" || exit 1
  RUN_ID="run-$(date -u +%Y%m%dT%H%M%SZ)"
  RUN="$BASE/$RUN_ID"
  helper mkdir-private "$RUN" && helper mkdir-private "$RUN/steps" && helper mkdir-private "$RUN/out" || exit 1
  printf '%s\n' "$RUN_ID" > "$BASE/current"
  values_set STARTED "$(now)"
  values_set COMMIT "$(git -C "$ROOT" rev-parse HEAD)"
  values_set HOST "$(uname -s) $(sw_vers -productVersion 2>/dev/null) $(uname -m)"
  values_set PROFILE "$PROFILE"
  values_set REQUESTER "$REQUESTER"
  values_set APPROVER "$APPROVER"
  values_set REFUSED_DIR "$REFUSED_DIR"
  values_set KEEP_ACCOUNT "$KEEP_ACCOUNT"
  values_set ACCOUNT "$ACCOUNT"
  values_set REGION "$REGION"
  values_set STATE_BUCKET "$STATE_BUCKET"
  values_set RUNNER_SHA256 "$(runner_digest)"
fi
printf '%s' "$CHECKLIST" > "$RUN/preflight.txt"
cp "$PREFLIGHT_DIR/deps.txt" "$RUN/out/preflight-deps.stdout" 2>/dev/null
rm -rf "$PREFLIGHT_DIR"
trap 'say ""; say "Interrupted. Resume with: scripts/mac-acceptance.sh --resume [same options]"; release_lock; exit 130' INT
say "Run: ${RUN#"$ROOT"/}"

run_steps
rule
say "All steps finished."
write_bundle || exit 1
retention_note
exit 0
