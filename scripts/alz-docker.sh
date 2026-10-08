#!/usr/bin/env bash
set -euo pipefail

# Operator launcher for the reviewed local Docker runtime.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

usage() {
  cat <<'HELP'
Sovereign Landing Zone — local Docker operator

  bash scripts/alz-docker.sh          Guided menu for first-time operators
  bash scripts/alz-docker.sh setup    Prepare image and protected local storage
  bash scripts/alz-docker.sh doctor   Inspect runtime security readiness
  bash scripts/alz-docker.sh status   Show installation status without building
  bash scripts/alz-docker.sh demo     Run a synthetic, non-mutating walkthrough
  bash scripts/alz-docker.sh help     Show this guide

No Node, npm, or cloud credentials are required on the host.
Live private models and live cloud discovery are NOT configured by setup.
Infrastructure ACT remains disabled.
HELP
}

problem() {
  printf '\nSetup stopped: %s\n' "$1" >&2
  printf 'No existing evidence keys or application volumes were removed.\n' >&2
  exit 1
}

require_docker() {
  command -v docker >/dev/null 2>&1 ||
    problem "Docker is not installed. Install and start Docker Desktop, then retry."
  docker info >/dev/null 2>&1 ||
    problem "Docker is not running or access was denied. Start Docker Desktop, then retry."
  docker compose version >/dev/null 2>&1 ||
    problem "Docker Compose is unavailable. Update Docker Desktop, then retry."
}

volume_access() {
  # A short-lived helper adjusts ONLY the dedicated named volume.
  docker run --rm --network none --user 0:0 \
    -v "$1:/data" --entrypoint chown \
    agent-private-landing-zone:local -R 1000:1000 /data
  docker run --rm --network none --user 1000:1000 \
    -v "$1:/data" --entrypoint sh \
    agent-private-landing-zone:local \
    -c 'test -w /data' ||
    problem "The application user cannot access storage volume $1."
}

installed_status() {
  require_docker
  if docker image inspect agent-private-landing-zone:local >/dev/null 2>&1; then
    printf 'Image: available (not proof of release qualification)\n'
  else
    printf 'Image: missing. Run setup first.\n'
  fi
  for volume in alz-runtime-data alz-evidence-keys; do
    if docker volume inspect "$volume" >/dev/null 2>&1; then
      printf 'Volume %s: available\n' "$volume"
    else
      printf 'Volume %s: missing; run setup\n' "$volume"
    fi
  done
  printf 'Security scan / release gate: NOT VERIFIED by this status check.\n'
}

guided_menu() {
  if ! test -t 0; then
    usage
    problem "The guided menu needs an interactive terminal. Use setup, doctor, or demo explicitly."
  fi
  while true; do
    printf '\nSovereign Landing Zone — choose your next step\n'
    printf '  1) Prepare my environment\n'
    printf '  2) Explore a safe demonstration\n'
    printf '  3) Review security readiness\n'
    printf '  4) Check installation status\n'
    printf '  5) Learn what the system can do\n'
    printf '  0) Exit\n'
    printf 'Selection: '
    if ! IFS= read -r selection; then
      printf '\nSession closed. No infrastructure changes were made.\n'
      return
    fi
    case "$selection" in
      1|2|3|4)
        case "$selection" in
          1) action=setup ;;
          2) action=demo ;;
          3) action=doctor ;;
          4) action=status ;;
        esac
        if ! bash "$ROOT/scripts/alz-docker.sh" "$action"; then
          printf 'That step failed. Follow the guidance above; the menu remains available.\n' >&2
        fi
        ;;
      5) usage ;;
      0) printf 'No infrastructure changes were made.\n'; return ;;
      *) printf 'Choose 0, 1, 2, 3, 4 or 5.\n' ;;
    esac
  done
}

if test "$#" -gt 1; then
  problem "Use one command at a time. Run help for supported commands."
fi

case "${1:-menu}" in
  status)
    installed_status
    ;;
  menu)
    guided_menu
    ;;
  help|-h|--help)
    usage
    ;;
  setup)
    require_docker
    command -v git >/dev/null 2>&1 ||
      problem "Git is required to identify the exact source revision."
    if test -n "$(git status --porcelain)"; then
      problem "The checkout has uncommitted changes; use a reviewed committed revision."
    fi
    export ALZ_SOURCE_COMMIT="$(git rev-parse --verify HEAD)"
    [[ "$ALZ_SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || problem "Cannot determine a valid committed source revision."
    printf 'Preparing local Docker runtime from commit %.12s…\n' "$ALZ_SOURCE_COMMIT"
    docker volume create alz-runtime-data >/dev/null || problem "Unable to create data volume."
    docker volume create alz-evidence-keys >/dev/null || problem "Unable to create evidence key volume."
    docker compose build alz ||
      problem "The verified image build failed. Review the build output; do not bypass attestation."
    volume_access alz-runtime-data
    volume_access alz-evidence-keys
    printf '\nStorage and image prepared. No cloud resources were changed.\n'
    printf 'Next: bash scripts/alz-docker.sh doctor\n'
    ;;
  doctor|demo)
    require_docker
    if ! docker image inspect agent-private-landing-zone:local >/dev/null 2>&1; then
      problem "Local image is missing. Run bash scripts/alz-docker.sh setup first."
    fi
    for volume in alz-runtime-data alz-evidence-keys; do
      docker volume inspect "$volume" >/dev/null 2>&1 || problem "Missing $volume. Run setup first."
    done
    # Presence of the image does not prove successful Trivy or release qualification.
    if test "$1" = doctor; then
      docker compose run --rm --no-deps alz doctor
    else
      printf 'Synthetic demonstration only. No live inventory, models or infrastructure changes.\n'
      docker compose run --rm --no-deps alz demo aws terraform brownfield
    fi
    ;;
  *)
    printf 'Unknown option: %s\n\n' "$1" >&2
    usage
    exit 2
    ;;
esac
