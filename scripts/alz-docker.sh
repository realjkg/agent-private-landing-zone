#!/usr/bin/env bash
set -euo pipefail

# Operator launcher for the reviewed local Docker runtime.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

usage() {
  cat <<'HELP'
Sovereign Landing Zone — local Docker operator

  ./scripts/alz-docker.sh setup    Prepare image and protected local storage
  ./scripts/alz-docker.sh doctor   Inspect runtime security readiness
  ./scripts/alz-docker.sh demo     Run a synthetic, non-mutating walkthrough
  ./scripts/alz-docker.sh help     Show this guide

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

case "${1:-help}" in
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
    printf 'Preparing local Docker runtime from commit %.12s…\n' "$ALZ_SOURCE_COMMIT"
    docker volume create alz-runtime-data >/dev/null
    docker volume create alz-evidence-keys >/dev/null
    docker compose build alz ||
      problem "The verified image build failed. Review the build output; do not bypass attestation."
    volume_access alz-runtime-data
    volume_access alz-evidence-keys
    printf '\nStorage and image prepared. No cloud resources were changed.\n'
    printf 'Next: ./scripts/alz-docker.sh doctor\n'
    ;;
  doctor|demo)
    require_docker
    if ! docker image inspect agent-private-landing-zone:local >/dev/null 2>&1; then
      problem "Local image is missing. Run ./scripts/alz-docker.sh setup first."
    fi
    # No build, npm, model download, or filesystem changes here beyond application evidence.
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
