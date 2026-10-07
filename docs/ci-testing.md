# CI and test policy

The plug-in catalog is the source of truth for adapter status.

When an adapter changes:

- update the implementation and its catalog entry in the same change
- derive tests from the catalog instead of copying status lists into tests
- run type-checking and the full test suite before merge
- treat a failing test as a behavior review first
- change an assertion only when the expected behavior is genuinely outdated

## Pull requests

Every pull request runs:

1. locked dependency install
2. TypeScript type-check
3. full test suite
4. plug-in catalog/runtime consistency check

New commits cancel older in-progress runs for the same pull request.

## Supply-chain checks

The heavier checks run after merge to `main`, weekly, or manually:

- dependency audit
- CycloneDX SBOM
- Trivy vulnerability scan
- infrastructure misconfiguration scan
- operator scenario smoke tests

This keeps merge feedback fast while retaining the full security baseline.

GitHub notification delivery is controlled by each account's notification settings. The workflows avoid duplicate push and pull-request runs so they do not create unnecessary failure events.
