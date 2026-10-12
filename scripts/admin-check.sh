#!/usr/bin/env bash
# One command for admins: builds, type-checks, runs the Node test suite, and reports the dependency status.
# One line per step on screen; full output for any failed step goes to a log file named in the line.
set -uo pipefail
cd "$(dirname "$0")/.."

LOG_DIR="${TMPDIR:-/tmp}/alz-admin-check"
mkdir -p "$LOG_DIR"
FAILED=0

step() {
  local name="$1"; shift
  if "$@" > "$LOG_DIR/$name.log" 2>&1; then
    echo "PASS  $name"
  else
    echo "FAIL  $name  (details: $LOG_DIR/$name.log)"
    FAILED=1
  fi
}

step build npm run build
step check npm run check
step tests npm run test:node
# An empty stdin means ./alz deps only reports and never shows an install dialog.
step dependencies ./alz deps </dev/null

if [ "$FAILED" -eq 0 ]; then
  echo "All checks passed."
else
  echo "Some checks failed. Send the log file named above."
  exit 1
fi
