#!/usr/bin/env bash
# Pre-merge check for one PR head: scripts/premerge.sh <head-sha>
#
# It test-merges the head onto the current main in a temporary worktree, reports the files that both main and the head
# changed since their merge base, runs the affected QA (scripts/qa-affected.mjs) and `npm run check` on the merge
# result, and removes the worktree. When the affected set is over the selector's cap, it runs the full quiet suite
# (`npm run test:quiet`) instead, after checking that the shared Ollama test port 11435 is free and no other quiet suite
# is running. It never pushes, merges or edits a branch. The head must be reachable from a fetched branch of the remote
# (a pushed commit), not only a local one. Logs are kept under .runs/premerge/<head>/, cleared at the start of each run.
#
# Exit codes: 0 every check passed; 1 a check failed, the selector failed or the merge conflicts; 2 usage; 3 a full
# suite cannot run now.
#
# Settings (environment): PREMERGE_REMOTE (default origin), PREMERGE_BRANCH (default main), PREMERGE_PROC_TCP (the
# socket tables read for the port check, default "/proc/net/tcp /proc/net/tcp6"), PREMERGE_SUITE_PATTERN (the process
# that marks a running quiet suite, default "scripts/test-quiet.mjs"). The suite check matches any command line that
# contains the pattern, a parent shell that only mentions it included: a false BUSY fails safe (exit 3).
set -uo pipefail

usage() { echo "usage: scripts/premerge.sh <head-sha>   (a full 40-character commit SHA)" >&2; exit 2; }
[ "$#" -eq 1 ] || usage
HEAD_SHA="$1"
[[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]] || usage

REMOTE="${PREMERGE_REMOTE:-origin}"
BRANCH="${PREMERGE_BRANCH:-main}"
PROC_TCP="${PREMERGE_PROC_TCP:-/proc/net/tcp /proc/net/tcp6}"
SUITE_PATTERN="${PREMERGE_SUITE_PATTERN:-scripts/test-quiet.mjs}"
OLLAMA_TEST_PORT_HEX="2CAB" # 11435

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && git rev-parse --show-toplevel)" || { echo "premerge: not in a git checkout" >&2; exit 2; }
cd "$ROOT" || exit 2
LOGS="$ROOT/.runs/premerge/$HEAD_SHA"
# One run per log folder: an earlier run's logs never nest into or sit beside this run's.
rm -rf "$LOGS"
mkdir -p "$LOGS"

git fetch -q "$REMOTE" || { echo "premerge: git fetch $REMOTE failed" >&2; exit 1; }
git cat-file -e "$HEAD_SHA^{commit}" 2>/dev/null || { echo "premerge: $HEAD_SHA is not a commit fetched from $REMOTE" >&2; exit 1; }
# A local-only commit is not a PR head: require a fetched branch of the remote that contains it.
[ -n "$(git for-each-ref --contains "$HEAD_SHA" --count=1 --format='%(refname)' "refs/remotes/$REMOTE/")" ] ||
  { echo "premerge: $HEAD_SHA is not reachable from any fetched $REMOTE branch (push it first)" >&2; exit 1; }
BASE="$(git rev-parse "$REMOTE/$BRANCH")" || exit 1
MERGE_BASE="$(git merge-base "$BASE" "$HEAD_SHA")" || { echo "premerge: no merge base between $BRANCH and the head" >&2; exit 1; }
echo "premerge: base $REMOTE/$BRANCH=$BASE head=$HEAD_SHA merge-base=$MERGE_BASE"

OVERLAP="$(comm -12 <(git diff --name-only "$MERGE_BASE" "$BASE" | sort) <(git diff --name-only "$MERGE_BASE" "$HEAD_SHA" | sort))"
if [ -z "$OVERLAP" ]; then echo "premerge: overlap with $BRANCH since the merge base: none"
else echo "premerge: overlap with $BRANCH since the merge base:"; sed 's/^/  /' <<<"$OVERLAP"; fi

TMP="$(mktemp -d)"
WT="$TMP/merge"
cleanup() {
  cd "$ROOT" || return
  git worktree remove --force "$WT" >/dev/null 2>&1
  rm -rf "$TMP"
  git worktree prune
}
trap cleanup EXIT
git worktree add -q --detach "$WT" "$BASE" || { echo "premerge: cannot create the temporary worktree" >&2; exit 1; }
cd "$WT" || exit 1
[ -d "$ROOT/node_modules" ] && ln -s "$ROOT/node_modules" node_modules

if ! git -c user.name=premerge -c user.email=premerge@localhost merge --no-ff --no-edit -q "$HEAD_SHA" >"$LOGS/merge.log" 2>&1; then
  echo "premerge: MERGE_CONFLICT"
  git diff --name-only --diff-filter=U | sed 's/^/  /'
  exit 1
fi
echo "premerge: test merge $(git rev-parse HEAD)"

# The full suite shares the Ollama test port with every other full suite on this host: never run two at once.
full_suite_free() {
  local table
  for table in $PROC_TCP; do
    [ -r "$table" ] || continue
    if awk -v port=":$OLLAMA_TEST_PORT_HEX" 'NR > 1 && toupper(substr($2, length($2) - 4)) == port { found = 1 } END { exit !found }' "$table"; then
      echo "premerge: port 11435 is in use ($table): another suite or model runtime holds it" >&2
      return 1
    fi
  done
  if pgrep -f "$SUITE_PATTERN" >/dev/null 2>&1; then
    echo "premerge: another quiet suite is running ($SUITE_PATTERN)" >&2
    return 1
  fi
  return 0
}

QA=FAIL
PLAN_EXIT=0
node scripts/qa-affected.mjs plan --base "$BASE" --out .runs/qa/plan.json >"$LOGS/qa-plan.log" 2>&1 || PLAN_EXIT=$?
# No readable plan, or a failing selector that reports no gap, is a selector error, not a coverage result.
GAPS="$(node -e 'const p=JSON.parse(require("node:fs").readFileSync(".runs/qa/plan.json","utf8"));const cap=/^Affected test count \d+ exceeds \d+/;const g=p.gaps||[];console.log(g.length===0?"none":g.every(x=>cap.test(x))?"cap":"gaps")' 2>"$LOGS/qa-plan-read.log")" || GAPS=error
[ "$PLAN_EXIT" -ne 0 ] && [ "$GAPS" = none ] && GAPS=error
case "$GAPS" in
  none)
    if node scripts/qa-affected.mjs local --base "$BASE" >"$LOGS/qa.log" 2>&1; then QA=PASS; fi
    echo "premerge: affected QA $QA ($(grep -E '^QA scope:' "$LOGS/qa.log" | tail -1))" ;;
  cap)
    echo "premerge: the affected set is over the selector cap; running the full quiet suite"
    if ! full_suite_free; then echo "premerge: FULL_SUITE_BUSY; serialize and rerun"; exit 3; fi
    if npm run test:quiet >"$LOGS/test-quiet.log" 2>&1; then QA=FULL_SUITE_PASS; else QA=FULL_SUITE_FAIL; fi
    echo "premerge: full suite $QA ($(tail -3 "$LOGS/test-quiet.log" | tr '\n' ' '))" ;;
  error)
    echo "premerge: SELECTOR_ERROR: the affected-QA selector failed (exit $PLAN_EXIT; log $LOGS/qa-plan.log):"
    tail -5 "$LOGS/qa-plan.log" | sed 's/^/  /' ;;
  gaps)
    echo "premerge: affected QA has coverage gaps (blocking):"; sed -n '/QA requires focused coverage/,$p' "$LOGS/qa-plan.log" | sed 's/^/  /' ;;
esac

CHECK=FAIL
if npm run check >"$LOGS/check.log" 2>&1; then CHECK=PASS; fi
echo "premerge: npm run check $CHECK"
[ -d .runs/tests ] && cp -R .runs/tests "$LOGS/tests"
[ -d .runs/qa ] && cp -R .runs/qa "$LOGS/qa"

[ "$GAPS" = error ] && QA=SELECTOR_ERROR
echo "premerge: RESULT head=$HEAD_SHA base=$BASE qa=$QA check=$CHECK logs=$LOGS"
case "$QA:$CHECK" in
  PASS:PASS|FULL_SUITE_PASS:PASS) exit 0 ;;
  *) exit 1 ;;
esac
