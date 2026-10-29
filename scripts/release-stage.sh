#!/usr/bin/env bash
# Stages the field package (docs/field-package.md, section 2): the one staging definition .github/workflows/supply-chain.yml
# runs and test/release-package-exclusions.test.ts runs. Run it from the root of a built checkout:
#
#   scripts/release-stage.sh STAGE_DIR
#
# It copies exactly dist/, policy/, config/, package.json, package-lock.json, alz and sbom.cdx.json into a new, empty
# STAGE_DIR. The owner's own files are left out of the stage, never out of the checkout: the pilot contract, its drafts and
# the retired pin (config/act-pilot-contract*, except the disabled *.example.json shapes), and the owner's evidence-runner
# configuration (config/evidence-runner.json). A checkout at the owner's authorization commit therefore still packages, and
# the package still carries no contract. The exclusion guard in src/cli/release-package.ts stays the fail-closed backstop
# for anything else.
set -euo pipefail

STAGE="${1:-}"
if [[ -z "$STAGE" ]]; then
  echo "usage: scripts/release-stage.sh STAGE_DIR" >&2
  exit 2
fi
if [[ -e "$STAGE" ]] && [[ -n "$(ls -A -- "$STAGE")" ]]; then
  echo "release-stage: $STAGE is not empty; stage into a new folder" >&2
  exit 1
fi
for source in dist policy config package.json package-lock.json alz sbom.cdx.json; do
  if [[ ! -e "$source" ]]; then
    echo "release-stage: $source is missing; build first (npm run build) and generate the SBOM" >&2
    exit 1
  fi
done

mkdir -p -- "$STAGE"
# Every later path is under this absolute, resolved folder, whatever characters STAGE holds (spaces, globs, a leading dash).
STAGE_ABS="$(cd -- "$STAGE" && pwd -P)"
cp -R -- dist "$STAGE_ABS/dist"
cp -R -- policy "$STAGE_ABS/policy"
cp -R -- config "$STAGE_ABS/config"
cp -- package.json package-lock.json alz sbom.cdx.json "$STAGE_ABS/"
chmod +x -- "$STAGE_ABS/alz"

# The owner's files: removed from the stage only, each one named. Names are read NUL-separated from inside the staged config/
# folder, so no character in a name or in STAGE can split a name or point the removal anywhere else; a path that does not
# resolve inside the stage is refused, never removed.
# The list is read completely before anything is removed.
mapfile -d '' -t owned_files < <(cd -- "$STAGE_ABS/config" && find . \( \( -name 'act-pilot-contract*' ! -name '*.example.json' \) -o -path './evidence-runner.json' \) -prune -print0)
for owned in "${owned_files[@]}"; do
  relative="${owned#./}"
  target="$STAGE_ABS/config/$relative"
  parent="$(cd -- "$(dirname -- "$target")" && pwd -P)"
  case "$parent/" in
    "$STAGE_ABS"/*) ;;
    *) echo "release-stage: refusing to remove a path outside the stage: config/$relative" >&2; exit 1 ;;
  esac
  printf "release-stage: left out the owner's config/%s\n" "$relative"
  rm -rf -- "$target"
done
