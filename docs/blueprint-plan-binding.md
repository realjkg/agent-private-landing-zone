# Blueprint native plan integrity handoff

## Scope and existing release boundaries

This review-only module supports the Sovereign ALZ **Inventory → Plan → Design →
approval → Execute → Verify → Operate (Maintain)** sequence. It does not add
an execution principal, authenticate an identity, or invoke infrastructure ACT.

`inspectBlueprintNativePlanBinding` combines existing blueprint completeness
validation, approval metadata, AWS governance checks and engine-native plan
classification without modifying the existing driver. Native plan JSON bytes
must be supplied by a trusted IaC adapter, and the independently sealed review
bundle must provide their exact SHA-256. The stage/account/region must be
independently verified by the execution host, never accepted from agent output.

`REVIEW` may return `REVIEWABLE` for a complete but not yet approved
blueprint. `APPLY_HANDOFF` returns `READY_FOR_DRIVER_REVIEW` only if
the blueprint was approved at its exact fingerprint, account and region match,
native-plan bytes match the sealed SHA, AWS governance classification is
acceptable and the existing release gate records verified prior-stage progress.

**READY_FOR_DRIVER_REVIEW is not approval to deploy.** The real ACT driver
must independently verify signed approvals, sealed artifacts, immutable
native plan bytes, target identity, applicable policy, stage-specific
capability leases, state locks and audit evidence before any mutation.
Synthetic/injected metadata and a well-formed hash do not establish trust.

## Explicit remaining integration

- Have the independently trusted Terraform/CDK/CloudFormation/Pulumi adapter
  produce canonical plan bytes and an immutable sealed review record.
- Bind the resulting digest and blueprint release to the actual apply driver
  and to the environment isolation contract proposed in PR #169.
- Verify secure review signatures, source provenance, runtime authorization,
  tenant identity and independently observed provider target.
- Include nested resource expansion and cloud-effective controls, not merely
  declared agent resource lists, in authoritative policy decisions.
- Perform authorized DEV/NON-PROD execution and verification before separately
  approving production.
- Keep ordinary DEV READ, design reviews, simulations, and local tests usable
  without requiring production credentials or invoking ACT.

This lane does not touch the local-only Linux hardening worktree. Independent
native runtime, signing, confinement, Studio SSO, provider and recovery gates
remain tracked in #39 and #77.
