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
# Refuse a stage the copy would land in, before anything is copied: the checkout itself, or a folder inside one of the copied
# sources (cp would copy a folder into itself and leave a partial copy in the checkout).
# Portable path resolution (Apple's bash 3.2 and BSD tools too; no GNU-only realpath -m or readlink -f): the longest existing
# prefix is resolved with cd -P, and the part that does not exist yet is appended as written. That part may not hold . or ..,
# which only the kernel could resolve once it exists.
resolve() {
  local path="$1" rest=""
  case "$path" in /*) ;; *) path="$PWD/$path" ;; esac
  while [[ ! -d "$path" ]]; do
    local leaf
    leaf="$(basename -- "$path")"
    if [[ "$leaf" == "." || "$leaf" == ".." ]]; then
      echo "release-stage: refusing a stage path with . or .. in a folder that does not exist yet: $1" >&2
      return 1
    fi
    rest="/$leaf$rest"
    path="$(dirname -- "$path")"
  done
  printf '%s%s\n' "$(cd -P -- "$path" && pwd -P)" "$rest"
}
ROOT="$(pwd -P)"
TARGET="$(resolve "$STAGE")"
if [[ "$TARGET" == "$ROOT" ]]; then
  echo "release-stage: refusing to stage into the checkout itself" >&2
  exit 1
fi
for source in dist policy config; do
  source_abs="$(resolve "$source")"
  if [[ "$TARGET" == "$source_abs" || "$TARGET/" == "$source_abs"/* ]]; then
    echo "release-stage: refusing to stage inside $source/, which is copied into the stage" >&2
    exit 1
  fi
done

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
# The list is read completely before anything is removed, and a find that fails stops the script (a process substitution
# would hide its exit status, so the list goes through a private temporary file, read NUL-separated; no mapfile, which
# Apple's bash 3.2 lacks).
owned_list="$(mktemp)"
trap 'rm -f -- "$owned_list"' EXIT
if ! (cd -- "$STAGE_ABS/config" && find . \( \( -name 'act-pilot-contract*' ! -name '*.example.json' \) -o -path './evidence-runner.json' \) -prune -print0) > "$owned_list"; then
  echo "release-stage: could not list the staged config/ folder; the stage is incomplete" >&2
  exit 1
fi
while IFS= read -r -d '' owned; do
  relative="${owned#./}"
  target="$STAGE_ABS/config/$relative"
  parent="$(cd -- "$(dirname -- "$target")" && pwd -P)"
  case "$parent/" in
    "$STAGE_ABS"/*) ;;
    *) echo "release-stage: refusing to remove a path outside the stage: config/$relative" >&2; exit 1 ;;
  esac
  printf "release-stage: left out the owner's config/%s\n" "$relative"
  rm -rf -- "$target"
done < "$owned_list"
