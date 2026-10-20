# Issue #39 — D4 AWS real provider qualification

The existing manual `Sovereign LZ Provider Production Qualification`
workflow uses protected GitHub environment `provider-qualification-aws`
and OIDC short-lived session credentials.

## Required protected environment variables

- `AWS_QUALIFICATION_ROLE_ARN` — explicitly scoped, read/preview
  qualification role in the expected AWS partition
- `AWS_QUALIFICATION_ACCOUNT_ID` — 12-digit target account that owns the
  controlled qualification stack (new, mandatory)
- `AWS_QUALIFICATION_REGION` — selected approved region
- `AWS_QUALIFICATION_STACK_NAME` — pre-existing controlled stack

The actual STS caller account and assumed-role ARN are fetched **after**
OIDC role assumption but **before** discovery or preview. A mismatch in
account, role name, AWS partition, region syntax, or stack name stops the job.
A role path is supported. No long-lived credentials, mutation permission,
resource creation, or cloud account bootstrap is introduced.

This is an identity guardrail only. It does not independently attest IAM
trust conditions, SCP controls, session duration or credential expiry; those
must be observed during D4 live acceptance.

## Required D4 evidence

A protected operator must configure and review the GitHub environment,
OIDC trust policy, least privilege, target account, region and a controlled
existing stack, then invoke the manual workflow. Collect a real
authenticated resource inventory, explicit validation result and non-executed
CloudFormation Change Set preview with SHA-256 output, tied to exact source.
Confirm ACT remains disabled and retain the workflow artifact URL in #39.

A green local test suite or successful account-binding preflight **never**
counts as real D4 qualification. The workflow must run on the authorized
non-production cloud account and complete the actual preview. D3 private
Qwen/Mistral target hardware qualification is independent and also remains
open until authentic evidence is linked.

Safe developer builds, offline discovery fixtures and unit tests are
unchanged; only the manually dispatched protected AWS qualification job
requires this extra account variable.
