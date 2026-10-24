# Independent model risk reconciliation and blocked-run provenance

This qualification path keeps local Qwen3/Mistral Nemo inference, synthetic AWS fixture evidence,
and live AWS discovery **strictly separate**. No model adjudication constitutes an IAM
authorization, Terraform apply, infrastructure ACT approval, or production release decision.

## Mac observation (2026-10-24)

The operator's Mac invoked all four configured roles (router Qwen3 1.7B, primary
Qwen3 4B, validator Mistral Nemo, adjudicator Qwen3 1.7B). All observed model
invocations emitted valid schemas. The primary named an unverified restore
capability; the independent validator named an insecure execution role. The
adjudicator chose `ABSTAIN`; the qualification runner returned
`INDEPENDENT_AGENT_ASSESSMENT_NOT_VERIFIED`. This is **authentic blocked
local inference**, not a preflight `NOT_RUN` and not successful qualification.
Both risks remain open and neither is proven resolved by the synthetic fixture.

## Model judgment and deterministic enforcement

The adjudicator now must return a structured `relationship`:
`ALIGNED`, `COMPLEMENTARY`, `CONFLICTING`, or `UNCERTAIN`.
`COMPLEMENTARY` means both findings may remain on the risk register and their
controls can be pursued without mutually exclusive or unsafe actions; it does
not mean the risks are resolved. The independent adjudicator must positively
assess *both* risks as addressable. The deterministic harness accepts only
`ALIGNED`/`COMPLEMENTARY` with **both** flags true, and otherwise
`ABSTAIN`s. Malformed schemas fail closed. Distinct risk names alone never
establish compatibility. Every downstream design, policy, authorization and
ACT gate still applies.

The primary and validator full assessments remain distinct, and a bounded risk
relationship record is attached to the agent result.

## Blocked-run output for the Mac kit

On a failed independent assessment, `qualify-aws-terraform-agent` writes
`.runs/qualification/aws-brownfield-terraform-private-agents-v1-<id>/qualification-blocked.json`
before exiting nonzero. The record has exact source SHA, model tags/digests,
observed role/schema participation, typed `BLOCKED` verdict, primary/validator
risk names, adjudication reason/relationship, and mandatory `ACT DISABLED`,
`NOT_GRANTED` authorization. It contains no raw model transcript, AWS
credentials, Terraform state, or plan. Treat even risk labels as internal
operational metadata. A blocked receipt is not a passed model qualification.

The standalone Mac evidence kit (distributed separately from GitHub) must
include this file only after validating its source/role/model/ACT bindings,
and must distinguish `BLOCKED` execution from never-started `NOT_RUN`.
Previously generated ZIP files cannot be retroactively made authoritative.
Only rerunning the updated ALZ build can collect this new receipt.

The maintained synthetic scenario is not an AWS account test. A later
approved AWS DEV run must independently establish identity, inventory,
native plan provenance and negative authorization evidence.
