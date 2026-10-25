# Autonomous merge admission — qualification evidence

This is the low-cost, documentation-only qualification scenario for `.github/workflows/reviewed-auto-merge.yml`. It does not authorize AWS ACT, infrastructure mutation, bypass of GitHub protections, or an agent approving its own PR.

## Acceptance criteria

1. A non-draft PR against `main` with `automerge:approved-scope` and an independent, exact-head `APPROVED` review may be admitted only after required exact-head checks and protected branch rules pass.
2. An otherwise eligible PR marked `superseded`, `superseded-by`, `obsolete`, `do-not-merge`, or explicitly replaced by a different PR is never auto-merged.
3. A PR with `CHANGES_REQUESTED`, unresolved review threads, a stale approval, missing checks, or disallowed architecture/ACT/release labels is never auto-merged.
4. The GitHub Actions workflow remains event-driven, has no polling, no repository checkout, no dependency installation and no model call, and caps a single admission job at two minutes. The per-run cap is **not** a monthly billing budget.
5. Approval must come from an authorized identity different from the PR author. A review-agent recommendation does not substitute for a GitHub approval.

## Minimal real-world qualification

Use this documentation-only PR as a harmless positive-path candidate **only after** an independent reviewer has examined its exact head and the repository's merge policies. Apply `automerge:approved-scope` only if permitted by maintainers. Observe the review-triggered admission job and GitHub native auto-merge state; retain the run URL, head SHA, check conclusions, reviewer identity, and merge SHA in issue #39. Do not manufacture a review or report a pass without the corresponding GitHub evidence.

For negative-path checks, use synthetic fixtures or a disposable test PR with an explicit supersession marker. Do not put supersession labels on real active work just to test the workflow. If auto-merge is unavailable or branch protection does not require an independent approval, record the configuration gap and stop rather than weakening protections.

## Follow-on engineering work

After qualification, continue implementation in non-overlapping workstreams: guided operator prerequisites and installer UX; DEV/STAGING/PROD isolation; deterministic affected-code QA; and AWS DEV ACT readiness evidence. Keep ACT disabled until separately authorized and verified.
