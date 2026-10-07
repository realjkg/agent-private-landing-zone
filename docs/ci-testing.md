# CI and test policy

The plug-in catalog is the source of truth for adapter status.

When an adapter changes:

- update the implementation and its catalog entry in the same change
- derive tests from the catalog instead of copying status lists into tests
- treat a failing test as a behavior review first
- change an assertion only when the expected behavior is genuinely outdated

## Pull requests

Pull requests use the fast deterministic gate needed to protect code quality:

1. locked dependency install
2. TypeScript type-check
3. unit/integration test suite
4. plug-in catalog/runtime consistency check

New commits cancel older in-progress runs for the same pull request.

A pull request is **not** a reason to run the full release gate. Live private-model qualification, broad supply-chain qualification, and release-wide end-to-end scenarios should run only when the release phase or a material qualification-sensitive change requires them.

## Release gate

Run heavyweight qualification once the release candidate actually needs it, not after every implementation refinement or merge.

The heavyweight workflows are manual release gates. Merging to `main` does not automatically start them.

Examples include:

- required Qwen/Mistral live-model qualification
- optional-model qualification only when that model or shared inference behavior changed
- full supply-chain/security qualification
- release-wide end-to-end scenarios

For private-model qualification, the required stack is the default manual gate. The optional Qwen3 8B job is opt-in.

Reuse valid qualification evidence when the runtime under release has not changed.

Documentation, coordination, formatting, and release-management-only changes do not justify a heavyweight run.

## Agent collision control

All coding agents follow the repository `AGENTS.md` protocol. During Milestone 1, Issue #39 is the active ownership ledger; a later milestone may explicitly name its successor.

Before editing or handing off code, agents check ACTIVE claims and open PR changed files. Overlapping paths are sequenced under a single active owner rather than edited concurrently.

This collision check is procedural and does not add another GitHub Actions workflow.

## Supply-chain checks

Supply-chain checks remain available as an explicit manual release gate:

- dependency audit
- CycloneDX SBOM
- Trivy vulnerability scan
- infrastructure misconfiguration scan
- operator scenario smoke tests

Keep routine feedback fast while retaining the full security baseline when it is actually needed.

GitHub notification delivery is controlled by each account's notification settings. Avoid duplicate or unnecessary workflow runs so routine development does not create avoidable Actions usage.
