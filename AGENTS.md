# Agent work and release rules

These rules apply to every coding agent working in this repository.

## Standing engineering standard — correct by construction

**Release outcome over PR throughput:** Engineering exists to deliver a usable, releasable product, not to maximize commits, green CI runs, or cleanup cycles. Prevent defects at design time; autonomous repair is exceptional, bounded recovery, never the normal development strategy.

1. **PLAN before coding.** Define the user journey, explicit acceptance criteria, typed interfaces, dependencies, invariants, trust/authorization boundaries, failure cases, and observable evidence. Reject ambiguous contracts before implementation.
2. **DESIGN the complete vertical slice.** Specify inputs/outputs, safe defaults, error reporting, security and policy checks, idempotency, restart/recovery and cleanup where applicable. Favor the existing guided `./alz` experience over exposing implementation details to operators.
3. **BUILD once, coherently.** Implement production behavior together with its focused positive, negative, interrupted and unauthorized tests. Do not defer basic validation, logging, edge cases, or recovery to a backend cleanup pass. Avoid redundant abstractions and speculative features.
4. **PROVE before pushing.** Run deterministic synthetic operator journeys and `scripts/qa-affected.mjs` scoped qualification against the actual change. Verify type/schema contracts and relevant security invariants. Synthetic evidence must be labeled synthetic and never substituted for live cloud acceptance.
5. **USE CI as independent verification.** Do not treat GitHub Actions as the primary debugger or rerun full repository/release gates for routine changes. Reserve consolidated end-to-end, security, provenance and provider gates for an immutable release candidate or an evidenced cross-cutting change.
6. **FIX root causes, not symptoms.** When a failure occurs, stop the affected lane, classify design versus implementation versus environment, correct the owning contract and smallest code slice, and add a regression test. No assertion weakening, silent retries, permission expansion, blanket timeouts or test suppression to achieve green.
7. **MEASURE first-pass quality and customer completion.** Evaluate first-pass acceptance, escaped defects, recovery behavior, clarity of prerequisites, and successful end-to-end journeys—not PR count, agent activity or CI green rate alone.
8. **BOUND unattended engineering.** GitHub Actions may host an unattended coding agent for code-only, path-scoped implementation and exceptional repair on its own branch, with bounded attempts, affected tests and auditable commits. It may not bypass review, required release gates, secrets boundaries, policy, cloud authorization or ACT. Repeated failures escalate to design review rather than an endless repair loop.

**Release boundary:** The final owner-supervised AWS DEV ACT acceptance, resource teardown, and independent cleanup verification remain separately authorized. No synthetic test or unattended coding agent enables infrastructure ACT or certifies a live release.

## Release loop

Use a lean loop:

1. **CLAIM** — check in before editing.
2. **IMPLEMENT** — make the smallest coherent change for the workstream.
3. **TARGETED CHECK** — run only the fast checks needed for the files and behavior changed.
4. **HANDOFF** — update the issue/PR with evidence and release the claimed paths.
5. **RELEASE GATE** — run heavyweight end-to-end qualification only when the release phase actually requires it.

Do not turn CI into the development loop.


### Required affected-QA agent cycle

**Persistent agent profile:** `.github/agents/qa.agent.md` defines the ALZ QA Steward for supported GitHub Copilot coding sessions. Apply its scope-selection, local repair, evidence, and merge-readiness contract to every normal engineering PR. PR CI operates on its own when no coding agent is running; the profile does not schedule a paid hosted agent or authorize infrastructure changes.

For every source, test, configuration, or workflow change, the coding agent must
run the deterministic local QA selector **before pushing**:

1. Install locked dependencies once for the checkout (not once per edit).
2. Use **node scripts/qa-affected.mjs plan --base origin/main** to inspect the planned tests.
3. Run **node scripts/qa-affected.mjs local --base origin/main** before handing off the PR.
4. If any check fails, diagnose the failing file and fix only its owning lane;
   rerun the same local affected QA until clean. Do not respond by relaxing an
   assertion, expanding cloud authority, or invoking the full suite.
5. Record changed paths, selected test files, and the local result in the PR.
   GitHub's affected-code check repeats that scope after each PR push.
6. A coverage-gap error blocks acceptance. Add an owning test or an explicit
   ownership rule to scripts/qa-affected.mjs with a selector unit test.
7. Run broad regression, provider qualification, or production release checks
   only for a justified release boundary. Never silently substitute synthetic
   checks for live provider evidence.

The selector intentionally follows module imports and a small set of safety
ownership rules. It does not guarantee coverage for filesystem-loaded fixtures,
dynamic runtime calls, or behavior invisible to unit tests. When those paths
change, add a focused test and explicit ownership before merge.

GitHub Actions does not run an unattended hosted coding agent or auto-commit
remediation. Local coding agents own the fix/recheck loop. A failed remote
check is an evidence handoff to the agent, and the PR stays unmerged.

## Local operator experience and output budget

- **Model-interface first:** the normal operator journey is the packaged, loopback-only Sovereign ALZ UI opened with `./alz`. Do not lead customers or operators through raw npm scripts, test files, setup menus, or verbose terminal output when the UI can carry the workflow.
- **Quiet by default:** verbose `npm run test:node` and complete test transcripts belong in CI or private engineering logs, not the user-facing workflow. For explicit local engineering qualification, use the existing concise `npm run test:quiet` runner; preserve full stdout/stderr under `.runs/tests/` and report counts, failure codes and exact source identity.
- **One-time local bundle:** source checkouts use `./alz bootstrap` to prepare the runtime and UI; its terminal output stays concise and detailed build logs stay in `.runs/bootstrap/`. Subsequent usage is `./alz`, without further npm commands.
- The interface checks local Qwen/Mistral readiness but does not silently pull weights, start inference, authenticate to cloud providers, switch stages, or authorize infrastructure mutation. If private inference is unavailable, show a clear BLOCKED/unavailable reason and offer the existing offline workflow.
- Synthetic model, IaC and identity tests must never be presented as authentic AWS provider qualification or production release approval.

## Deterministic execution sequence

Every workstream uses one execution order:

1. **PLAN** — establish one authoritative task plan, scope, ownership, evidence inputs, and acceptance gate before implementation.
2. **DO** — execute independent, non-overlapping lanes in parallel when useful. A lane may retry inside its assigned scope, but it may not change the parent plan, another lane's ownership, or its own authority.
3. **CONVERGE / VERIFY** — bring typed artifacts and evidence back to one serialized validation point. Resolve collisions, compare against the approved plan/design, and run the smallest deterministic checks required.
4. **ACT** — cross one controlled integration boundary only after verification. For repository work this means the merge/release decision. It does not enable infrastructure mutation; that is governed only by the approved pilot PLAN below.

A bounded implementation or validation failure returns only to the affected **DO** lane. If architecture, policy intent, ownership, or source assumptions changed, stop that iteration and create a new **PLAN** rather than silently mutating the current one.

Do not run multiple independent PLAN or ACT authorities for the same workstream. Parallelism belongs inside **DO**; convergence and ACT are serialized.

The product runtime default remains **ACT = DISABLED** for infrastructure mutation. The repository owner approved one exception on 2026-10-11: the internal reference build (customer zero) may enable ACT for a dev-to-production pilot, only under `docs/act-pilot-plan.md`, its release contract, and its gates. No other change, flag, environment variable, or agent decision may enable ACT, and agents never initiate an apply. The same owner decision, recorded 2026-10-12, widens how a human may invoke the pilot: a person at the terminal, or a person in the console's guided Pilot apply wizard who holds the one-time session token the console prints in the terminal where it was started. One pilot workflow runs wholly in one of the two, chosen when it is started and bound into the sealed plan, never mixed. This does not enable ACT: the shipped pin stays empty, ACT stays disabled, agents and the console's job table still never initiate an apply, and every gate (contract pin, qualification evidence, approvals, ledger, kill switch, typed phrases) is the same in both. `src/cli/ui-channel.ts` is the console's only bridge to `src/apply` (`test/apply-boundary.test.ts`).

## No-collision check-in

Issue #39 is the active Milestone 1 coordination ledger. If a later milestone explicitly names a successor ledger, that milestone ledger supersedes this number.

Before editing code, post an `AGENT CHECK-IN` comment in the active coordination ledger with:

- release phase
- workstream
- branch
- base SHA inspected
- claimed files or path globs
- related issue/PR
- `status: ACTIVE`

Then inspect:

- ACTIVE claims in the active coordination ledger
- changed files in open PRs
- current base/main head

If another ACTIVE workstream overlaps a claimed path, do not edit that path. Re-scope, sequence the work after the owner, or hand the shared file to one integration agent.

Shared integration files such as workflow definitions, central catalogs, package manifests, and common runtime entry points have **one active owner at a time**.

Before the first push and again before PR handoff:

- refresh the intended base
- repeat the overlap check
- verify no claimed path changed underneath the workstream
- never use a force push to overwrite another agent's work

When work is merged, abandoned, or handed off, post an `AGENT CHECK-OUT` comment in the active coordination ledger with `status: RELEASED`.

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
- enable ACT or mutation capability except through the approved pilot PLAN, its contract, and its gates

The deterministic policy boundary remains authoritative.

## U.S. English editorial standard

Write all original documentation, comments, user-visible text, examples, generated reports, tests, and agent-authored PR summaries in **U.S. English (en-US)**. Prefer color, behavior, optimize, analyze, organization, authorization, license, center, gray, canceled and modeled. Review AI-generated prose before committing it.

Preserve published API/JSON identifiers, code symbols, exact CLI names, official product names, third-party materials, quoted sources and legal text when a spelling change would affect interoperability or fidelity. Do not use mass string replacements on source code. Keep this a documentation convention; it does not change any release, security, model, or infrastructure authority.
