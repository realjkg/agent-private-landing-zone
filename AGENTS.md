# Agent work and release rules

These rules apply to every coding agent working in this repository.

## Release loop

Use a lean loop:

1. **CLAIM** — check in before editing.
2. **IMPLEMENT** — make the smallest coherent change for the workstream.
3. **TARGETED CHECK** — run only the fast checks needed for the files and behavior changed.
4. **HANDOFF** — update the issue/PR with evidence and release the claimed paths.
5. **RELEASE GATE** — run heavyweight end-to-end qualification only when the release phase actually requires it.

Do not turn CI into the development loop.

## No-collision check-in

Issue #12 is the coordination ledger.

Before editing code, post an `AGENT CHECK-IN` comment there with:

- release phase
- workstream
- branch
- base SHA inspected
- claimed files or path globs
- related issue/PR
- `status: ACTIVE`

Then inspect:

- ACTIVE claims in Issue #12
- changed files in open PRs
- current base/main head

If another ACTIVE workstream overlaps a claimed path, do not edit that path. Re-scope, sequence the work after the owner, or hand the shared file to one integration agent.

Shared integration files such as workflow definitions, central catalogs, package manifests, and common runtime entry points have **one active owner at a time**.

Before the first push and again before PR handoff:

- refresh the intended base
- repeat the overlap check
- verify no claimed path changed underneath the workstream
- never use a force push to overwrite another agent's work

When work is merged, abandoned, or handed off, post an `AGENT CHECK-OUT` comment in Issue #12 with `status: RELEASED`.

## GitHub Actions efficiency

Conserve GitHub Actions minutes.

For ordinary PR development, use the smallest deterministic gate needed to catch code regressions. Do **not** run the full end-to-end release gate for every PR or every refinement.

Heavyweight checks include:

- live private-model qualification
- complete Qwen/Mistral stack qualification
- broad supply-chain/security qualification
- release-wide end-to-end scenarios

Run those only when one of these is true:

- the release candidate is ready for its release gate
- qualification-sensitive runtime behavior materially changed
- prompt/security policy materially changed
- model/runtime configuration materially changed
- a targeted failure specifically requires the heavier evidence

Documentation, coordination, formatting, and release-management-only changes do not justify a heavyweight model run.

Reuse valid qualification evidence when the runtime under release is unchanged.

## Safety and authority

Green CI is not a reason to weaken a control.

Do not:

- relax security assertions just to pass
- increase timeouts merely to hide an inference problem
- broaden model, tool, or approval authority
- enable ACT or mutation capability as part of release progression

The deterministic policy boundary remains authoritative.
