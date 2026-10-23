# ACT-DEV-1 — Terraform-only AWS bootstrap and acceptance

**Owner decision (2026-10-23):** qualify one human-supervised, additive CloudWatch log-group canary in a dedicated AWS DEV member account. Production admission, CDK, full FinOps integration, and private-model qualification are successor lanes, not prerequisites. The runtime's global ACT default remains disabled.

## Dependencies (no skipped gates)

| Gate | Next valid action | Exit evidence | Refusal |
|---|---|---|---|
| D0 Source | Use a clean exact main commit with scoped QA | commit, lock hash, passing affected tests | SOURCE_UNVERIFIED |
| D1 Account | Owner creates/verifies DEV member account under governed Workloads OU | independent STS, Organizations and Control Tower observations | ACCOUNT_REQUIRED |
| D2 Finances | Owner verifies credits or separately authorizes bounded expense; budget alerts with subscriber verification | approved cumulative ceiling, canary forecast, policy bounds | SPEND_NOT_AUTHORIZED |
| D3 Bootstrap | Owner separately plans/applies `bootstrap/aws` | distinct IAM ARNs, exact OIDC trust, S3 policy/ownership/encryption/versioning/lock and outputs | BACKEND_UNVERIFIED |
| D4 Identities | Prove four separate token subjects/paths and independent STS sessions on one approved execution host | issuer/audience/sub, short expiry, role/account, CloudTrail; no raw JWT in evidence | OIDC_SUBJECT_MISMATCH |
| D5 Contract | Owner supplies authentic DEV target + Ed25519 public key; reviews and pins exact enabled contract | committed contract, SHA pin, DEV-only scope, kill switch | CONTRACT_UNPINNED |
| D6 Qualify | Run no-apply real Terraform qualification | tool/provider digests, encrypted qualification record, independent CloudTrail/state evidence | QUALIFICATION_MISSING |
| D7 Canary | A person seals, approves, and applies exactly one additive log group | immutable plan, approval, actual state and CloudTrail mutation | APPLY_BLOCKED |
| D8 Verify | Independent read back, deny/replay tests and owner cleanup decision | resource, region, tags, 30-day retention, state serial, evidence, later billed cost | OBSERVATION_MISSING |

Never call `bootstrap/aws` from the ACT APPLY identity. The bootstrap needs a separately held, time-bound administrative identity and separately managed Terraform state. Read-only discovery is permitted with an already approved account-owner session. No cloud mutation or incremental AWS spend is authorized by this document.

## DEV-only contract

A new contract may declare exactly `"enabledEnvironments":["DEV"]` and include only `targets.DEV` and `requiredApprovals.DEV`. Both **must** exist. QA and PROD are *disallowed*, not guessed or auto-created. The legacy contract without `enabledEnvironments` continues to require three distinct account/backend targets with two production approvers. Intermediate subsets are rejected. Merely writing `enabled:true` is insufficient: missing reviewed key, pin, identities, or qualification remain blocking.

`config/act-pilot-contract.aws-dev.example.json` is intentionally invalid/disabled; never commit real account secrets or private keys. The operator creates `config/act-pilot-contract.json` with authentic values, uses the native contract inspection/preflight, then invokes the owner-reviewed `./alz apply pin` ceremony only after the target, identity delivery and finance gates are met. The SHA pin in `config/act-pilot-contract.sha256` ships **empty**.

## OIDC subject delivery: unresolved engineering dependency

Choose a single trusted execution host and prove how it securely receives **four distinct, currently valid tokens** with exact subjects for DISCOVERY, STATE, STATE_WRITE and APPLY. AWS role trust must match the token's **observed** `sub` and `aud` claims; the bootstrap accepts exact `oidc_subjects` values. GitHub added immutable `owner@id/repo@id` defaults for repositories created/transferred after July 15, 2026; older repositories can opt in. Do not assume the old `repo:OWNER/REPO:environment:NAME` string. Review GitHub's current OIDC reference before bootstrap.

A GitHub Actions job is bound to one environment subject. It **cannot** mint four distinct environment subjects inside one ordinary job by requesting four tokens. Four jobs alone do not solve secure delivery to a single runtime: transferring JWTs via build artifacts or logs is prohibited. A reviewed trusted broker/host with restricted ephemeral storage and independently verified subject binding is required, or an approved self-controlled identity issuer with four restricted subjects. Until evidence exists, D4 remains BLOCKED. No fallback to operator `AWS_PROFILE`, static keys, or shared token files.

The owner can collect non-secret STS identifiers and CloudTrail event IDs; redact account-owner particulars in shared reports. Token issue time, expiry and issuer claims alone are **not** cryptographic verification: successful independent STS role assumptions and CloudTrail corroboration are required.

## Cost and policy bounds

Cumulative AWS pilot credit ceiling is $80. AWS Budgets is advisory, not a hard ceiling. Existing historical management-account Cost Explorer data ($14.75 in October; zero budgets at prior observation) is not DEV canary spend. A dedicated DEV account and approved max spend are prerequisites for any billable operation. The canary policy should allow only a named CloudWatch Logs group in `us-east-2` with mandatory tags and 30-day retention, and explicitly deny modifications to IAM/OIDC/backend/control-plane resources. Existing SCP/RCP may further constrain actions; neither alone grants IAM permission.

Cleanup cannot be claimed complete until an independently approved owner deletion/read-back or a separately qualified bounded cleanup capability exists. The ACT driver does **not** expose general destroy.

## Acceptance scope

ACT-DEV-1 proves only the exact account, source commit, Terraform binary/provider lock, identity subjects, contract, state backend, region, resource type and observed canary. No claim of CDK support, general AWS ACT, production release, or production admission follows automatically. Unauthenticated fixture tests remain unit evidence; authenticated live AWS checks remain to be performed by the account owner.
