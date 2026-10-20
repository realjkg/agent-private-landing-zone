# Environment-bound blueprint admission — development-preserving contract

Issue #147 · Milestone #39 · Pure deterministic admission module: `src/governance/stage-isolation.ts`.

This is a bounded implementation lane independent from the unpushed 31-file
Linux runtime worktree (`feat/linux-runtime-hardening`, local commit `cb3c8f4`).
It introduces **no authority to deploy** and does not claim to implement full
cross-cloud execution isolation.

## Target evidence

A canonical `StageTarget` declares tenant, environment ID, stage
(DEVELOPMENT, STAGING, PRODUCTION), provider, account/project, region, exact
execution identity reference, state namespace, evidence namespace, and key
scope. No provider or stage defaulting is permitted. Environments are not
interchangeable merely because a tenant or provider matches.

For scoped state and evidence storage, use
`<tenant>/<stage>/<environment>/<purpose>`. The key reference must
be bound to the same tenant/stage/environment scope. No literal secrets
enter this contract.

`admitStagePlan` requires the independently authenticated target to match
the plan target on all fields. For apply eligibility, it requires observed
evidence references for policy, inventory, recovery and review. STAGING
requires a DEVELOPMENT source; PRODUCTION requires a STAGING source.
The source and target must have separate account, environment, execution
identity, state and key scope. A promotion must bind the exact blueprint,
sealed artifact and verified source plan fingerprint, plus independent
review evidence.

The deterministic binding SHA is suitable for including in a *future*
immutable signed execution envelope. It is **not itself a signature** and
does not prove evidence authenticity. The existing signed ACT driver and
environment-specific policy remain authoritative.

## Compatibility

- Development READ and PREVIEW requests do not require production
  attestation, runtime confinement or live provider credentials.
- Synthetic planning/tests remain possible, but fixture data is never
  accepted as APPLY evidence.
- The module has no network access, shell access or mutation function.
- This initial contract must be wired to the source-bound apply driver
  and verified against production account identities before rollout.
- It does not change the Milestone 1 ACT=DISABLED default or qualify
  Dev/Non-Prod/Production deployment.

## Acceptance and remaining tasks

The focused unit tests cover positive developer preview, explicit
stage progression, cross-tenant/session mismatch, invalid stage,
cross-scope keys/state, stale promotion fingerprints, missing review,
and attempted privilege escalation. Exact-head CI is required before merge.

Remaining: connect actual verified identity claims and sealed native
IaC plans to this contract, verify namespace/key isolation with
real storage and permissions, test the console and provider workflows,
and obtain target-specific security and live release evidence.
