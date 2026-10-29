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
if [[ -e "$STAGE" ]] && [[ -n "$(ls -A "$STAGE")" ]]; then
  echo "release-stage: $STAGE is not empty; stage into a new folder" >&2
  exit 1
fi
for source in dist policy config package.json package-lock.json alz sbom.cdx.json; do
  if [[ ! -e "$source" ]]; then
    echo "release-stage: $source is missing; build first (npm run build) and generate the SBOM" >&2
    exit 1
  fi
done

mkdir -p "$STAGE"
cp -R dist "$STAGE/dist"
cp -R policy "$STAGE/policy"
cp -R config "$STAGE/config"
cp package.json package-lock.json alz sbom.cdx.json "$STAGE/"
chmod +x "$STAGE/alz"

# The owner's files: removed from the stage only, each one named.
find "$STAGE/config" \( -name 'act-pilot-contract*' ! -name '*.example.json' \) -o -path "$STAGE/config/evidence-runner.json" |
  while IFS= read -r owned; do
    echo "release-stage: left out the owner's ${owned#"$STAGE"/}"
    rm -rf -- "$owned"
  done
