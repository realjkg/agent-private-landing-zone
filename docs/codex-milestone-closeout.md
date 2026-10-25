# Codex execution contract — complete ALZ Preview/Operate, then prepare gated ACT

## Launch from a checked-out repository

Run this from the repository's root using a Codex CLI installation already
authenticated by the human operator:

```sh
codex exec --sandbox workspace-write - < docs/codex-milestone-closeout.md
```

The workspace-write sandbox permits local code edits and targeted tests,
**not** automatic IAM escalation, cloud changes, review bypass or a promise
that remote protected gates can complete. On a later explicitly invoked
session, continue with `codex exec resume --last` and instruct Codex to
reconcile fresh Issue #39/main evidence before doing more work. Codex
does not become a standing background operator merely because this
instruction exists.

**Copy this entire document into Codex with repository access.** This is a
bounded engineering instruction, not a grant of cloud permissions. Continue
iterating through all tasks that can actually be completed on the connected
host; do not stop after generating an additional plan. Stop at genuinely
indispensable human, protected-environment or hardware gates, report exact
blocked conditions and resume when independently authorized evidence arrives.

## Mission and immutable facts

Repository: `realjkg/agent-private-landing-zone`.

Canonical Milestone 1 ledger: [Issue #39](https://github.com/realjkg/agent-private-landing-zone/issues/39).
Additional pilot ledgers: [#184](https://github.com/realjkg/agent-private-landing-zone/issues/184),
[#199](https://github.com/realjkg/agent-private-landing-zone/issues/199).
GCP future provider: [#141](https://github.com/realjkg/agent-private-landing-zone/issues/141).

Owner-stated original author: **JK Gonzalez**. Brand designation:
**Sovereign ALZ®**, with registered status **asserted by the owner**.
The existing MIT `LICENSE` identifies **Adapt Cloud** as copyright holder.
All strategic service providers may use, adapt and commercialize MIT-licensed
code, subject to the MIT notice. Attribution is visible in
`src/brand/identity.ts` and the release manifest; it does not create
a license gate or attest trademark registry particulars.

**Milestone 1 release is PREVIEW_OPERATE with infrastructure ACT DISABLED.**
No global ACT toggle, no generic apply/deploy/destroy, no model-authorized
mutation, no silent cloud account creation. The separately documented,
owner-authorized, single-purpose human-supervised AWS DEV Terraform pilot is
not a shortcut around Milestone 1 release admission.

## Loop: run to the last possible safely verifiable gate

Repeat these steps in order as long as work is possible:

1. **RECONCILE:** fetch `origin/main`, read `AGENTS.md`, Issue #39 and
   latest comments, current open PR heads and changed paths, ACTIVE path claims,
   source commits, exact-head QA/CodeQL and applicable security checks.
   Read existing work before writing anything. Do not duplicate already
   merged #171/#172/#180, Linux runtime hardening, or the live LZ journey.
   A previous report is not proof of current state.
2. **SELECT:** choose the earliest unsatisfied task whose prerequisites are
   satisfied and whose files are unclaimed. Parallelize only non-overlapping
   DO lanes; shared source/workflows have one owner.
3. **CLAIM:** post the Issue #39 AGENT CHECK-IN format from `AGENTS.md`,
   naming branch, exact main base and exclusive file paths. If claim cannot be
   recorded, do not change shared paths.
4. **IMPLEMENT:** real minimal code plus threat/negative tests, docs and
   evidence output, reusing the existing interfaces. Never substitute
   another throwaway runner, misleading mocked green status or admin
   workaround for the original qualification gate.
5. **TEST:** `npm ci` once per checkout. Run
   `node scripts/qa-affected.mjs plan --base origin/main` and
   `node scripts/qa-affected.mjs local --base origin/main` before push.
   Correct owned failures without weakening controls. Run `npm run test:quiet`
   and heavier tests only if the change justifies them. Never invent a PASS.
6. **HANDOFF:** push a non-force branch, open a reviewable PR, report changed
   paths, local test selection/results, full source SHA and security limits.
   Recheck overlaps, current main, exact PR-head CI, CodeQL, required reviews
   and branch protections. Never self-bypass required reviews. Release claim
   by AGENT CHECK-OUT.
7. **CONTINUE:** move to the next independent task if PR review or hardware
   is pending. Do not wait idly, duplicate the task, change the admission
   rules or automatically start infrastructure ACT.
8. **STOP CONDITION:** only report FINISHED after **every** applicable
   Issue #39 DO, CONVERGE, VERIFY, RELEASE and MANAGE box is backed by
   admissible current evidence and human review; then stop. Otherwise report
   IMPLEMENTATION_ADVANCED or BLOCKED_BY_AUTHORIZED_OPERATOR, with concrete
   next task, required actor and evidence artifact. Never close #39 early.

No time-based endless polling loop. For live events a privileged runner may
resume on an explicit new invocation; nothing here starts a background agent.

## DO-1: Complete the operator-ready evidence runner

Build on `src/cli/lz-live-journey.ts`,
`src/qualification/lz-live-journey.ts`, existing UI `./alz`,
`scripts/lz-journey-evidence.py`, the provider qualification tools,
and their tests.

The human journey must be:

```text
OPEN ALZ
  → LOCAL READINESS (versions, tools, Ollama, required digests)
  → SELECT EXACT PERSONAL TEST ACCOUNT / REGION / STAGE
  → IDENTITY (approved short-lived, target-bound principal; no ambient fallback)
  → EXPLAIN REAL API CALLS AND PREVIEW SIDE EFFECTS
  → LIVE PRIVATE MODEL + INDEPENDENT VALIDATOR
  → LIVE SCOPED PROVIDER DISCOVERY
  → GOVERNANCE + OWNERSHIP + UNKNOWN RECONCILIATION
  → OPERATOR-REVIEWED DESIGN / TERRAFORM OR CDK PREVIEW
  → SOURCE-BOUND EVIDENCE + HUMAN REVIEW
  → RELEASE HOLD UNTIL ISSUE #39 QUALIFICATION
```

Show actual local Ollama tags; do not ask the operator to enter
`YOUR_GRANITE_TAG` or `YOUR_NEMOTRON_TAG`. Default to existing required
`qwen3:1.7b`, `qwen3:4b`, `mistral-nemo:latest`. Granite/Nemotron are
comparison-only until explicitly selected and installed; no silent download
or swap. A local Mac check does not count as production D3 Linux target proof.

Keep account packets distinct, with source SHA, exact target account ID /
subscription / project, region and stage, ARN or nonsecret principal reference,
subject/issuer/audience when observable, tool versions, model digests,
prompt-policy hash, resource and native plan digests, consent scope, and
timestamps. Use statuses PASS/FAIL/BLOCKED/NOT_RUN/NOT_APPLICABLE and
evidence class SYNTHETIC/LOCAL_MODEL/LIVE_PROVIDER/NATIVE_PREVIEW.
Refuse cross-account reuse, stale source/plan or mismatched IAM principal.
Per-file SHA256 checksums are integrity checks, **not** provider authenticity.

Private evidence files must exclude tokens, raw state, plaintext secrets,
hidden prompts and unredacted account inventories. Export a separate minimal
redacted sharing packet. A PASS in a synthetic fixture must never satisfy a
D3/D4/D5 production row.

Terraform: allow only reviewed project code and governed plan/validate, no
apply; `-refresh=false` is not live drift proof. CDK: synth invokes code and
temporary Change Set create/delete are AWS writes; require additional
explicit preview-write capability and human consent, never execute.
Record cleanup failures as BLOCKED.

Minimum negative tests: wrong account/region, stale principal, static-credential
fallback, wrong model digest, required validator skipped, ABSTAIN, poisoned
evidence, parser truncation, partial discovery, external project code,
unexpected UPDATE/DELETE, plan tampering, Change Set cleanup failure,
missing evidence, checksum mismatch, cross-account report collision, and
an attempted apply/deploy path.

## DO-2: D3 — authentic private-model production target

`docs/target-preflight.md` and
`.github/workflows/model-production-qualification.yml` are existing
authorities. Do not replace the dedicated self-hosted Linux runner
(`self-hosted,linux,alz-private-model`) with a hosted or Mac smoke run.

Prestage required three model weights, pinned Ollama 0.40.0, Node 26,
Terraform and a loopback service at 127.0.0.1:11435. Operator supplies
stable nonsecret hardware ID, accelerator, installed model store and
workflow dispatch. Run quick diagnostic scopes `first`, then final
`all`, only on the actual qualified hardware.

D3 evidence must bind exact source/policy/model digests and test
structured outputs, indirect prompt injection, secret canaries,
independent Mistral validation, no skipped checks, restart/checkpoint
continuation, long-run session, memory pressure, safe timeout/ABSTAIN,
and no cloud inference dependency. No model timeout inflation or
automatic model switch. If real runner/hardware unavailable, D3=NOT_RUN
and state exact host prerequisites.

## DO-3: D4 AWS and D5 Azure protected provider tests

Use the existing `.github/workflows/provider-qualification.yml`;
separate protected environments
`provider-qualification-aws` and `provider-qualification-azure`.
Human administrator configures environment reviewers, target IDs,
federated trust, exact role/client, region and nonproduction personal
resources. OIDC workflow credentials must be short-lived. AWS SSO/SAML
human login is useful for preflight but is not a substitute for the
runner's protected DISCOVERY OIDC binding. Azure Entra federation or
managed identity is different from an interactive `az login` session.

AWS: verify STS account/role, allowed region, real resources and scoped
CloudFormation native preview, ensuring no execute-change-set. Distinguish
Change Set control-plane create/delete from true read-only calls.
Azure: verify tenant/client/subscription, real resources and Bicep What-If
with no deployment. Source-bound authentic artifacts are mandatory.
Personal-account success does not qualify an organizational/customer estate.

GCP is not a completed Milestone 1 provider gate: follow #141 for scoped
Workforce/Workload Identity Federation onboarding; do not declare generic
cloud authentication to be GCP production qualification.

## DO-4: D6 security, recovery and repository administration

Verify actual GitHub `main` protections/rulesets rather than assuming
workflow YAML enforces them. Admin must enable required exact-head
deterministic PR validation, no force pushes/deletion, and independent
reviews for release-sensitive changes. Keep external Actions SHA pinned,
non-provider job permissions `contents: read`, provider jobs' OIDC
`id-token: write` limited to protected environments.
Run native container vulnerability/misconfiguration scans, SBOM,
OPA parity, secret redaction, artifact signing/provenance, tested isolated
control-plane restore and recovery checks on the immutable candidate.
Do not weaken severity criteria or silently downgrade findings.

## CONVERGE → VERIFY → RELEASE → MANAGE (Issue #39)

Only when D3, D4, D5, D6 are accepted, freeze **one** immutable main SHA,
deployment contract version, prompt-policy hash, exact hardware/model
digests and AWS/Azure evidence lineage. Build one evidence index including
OPA, recovery, supply chain, SBOM, reproducibility, known UNKNOWNs and
`ACT=false`. A single VERIFY decision tests the frozen candidate, not
a different SHA. A VERIFY failure returns to the owning DO lane,
then reconverges and re-verifies; never edit code inside VERIFY.

Publish only after independent approval: exact signed artifact/tag/SBOM
and source-bound manifest including JK Gonzalez authorship and upstream
brand fingerprint. Establish retention, drift, incident response,
release upgrade/rollback, monitoring and continuing MANAGE ownership
before closing Issue #39. No generic cloud mutation is introduced.

## ACT pilot readiness (separate conditional successor)

A full Milestone 1 Preview/Operate release does not enable generic ACT.
After completing the milestone and its MANAGE handoff, prepare the
existing separately owner-approved AWS DEV Terraform canary gates in
`docs/act-pilot-plan.md`, `docs/act-dev-1.md`, Issues #184/#199.

Prove: dedicated DEV member account, real finance/budget authorization,
separately owned bootstrap, four distinct valid identity subjects and
effective STS roles, backend STATE_WRITE vs APPLY isolation (including
embedded backend identity in sealed Terraform plan), state locking,
reviewed/pinned DEV-only contract, signed exact artifact, replay/expiry
and wrong-target denials, human action, kill switch, bounded resource,
independent CloudTrail/state read-back and recovery/cleanup.
**Never** run account creation, role provisioning, Terraform apply/destroy
or enable the contract automatically. A human operator and separate
approver(s) must explicitly execute the approved workflow when the actual
gate is satisfied; stop with BLOCKED if any element is absent.
Do not extend a DEV proof to QA, PROD or customer estates.

## Final report contract

On each invocation write a short, factual checkpoint:
- inspected exact main SHA, open PR and ACTIVE claim status;
- changed files, branch, head SHA, PR link, local test results,
  exact-head CI, security checks and reviews;
- D3, D4, D5, D6 statuses and evidence references;
- independent release decision HOLD/GO (GO only if verified);
- pilot readiness separate from release and ACT always DISABLED
  unless a specific human-approved pilot action actually happened;
- next unblocked implementable task, or the exact indispensable
  operator-controlled gate.

Do not issue empty status reports or call a task complete based on
fixtures, a SHA checksum, a code review without CI, or a personal
account being mistaken for production admission.
