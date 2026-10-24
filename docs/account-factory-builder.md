# Sovereign ALZ Builder — customer-first Account Factory workflow

## Who uses it

**Delivery owner:** leads customer intake, validates real account and organization authority, prepares DEV/QA/PROD environments, records approvals, and signs over an evidence-backed deployment.

**Digital Operations:** takes ownership of monitoring, configuration baselines, drift, cost controls, change requests and recovery runbooks.

**Presales architect:** discovers approved brownfield posture, creates solution blueprint and cost scenarios; cannot submit cloud account creation.

The **single ALZ Builder operations catalog** is the surface. Current implementation provides guided, authenticated operator handoffs under Account Factory and does not yet include a dedicated end-user wizard or production-ready remote Studio/MCP integration. Describe this accurately in customer demonstrations.

## Delivery journey and current commands

The customer-oriented journey is: customer intake → authenticated discovery → account plan → human approval and finance check → provision with existing Control Tower → independently verify governed account → handoff to Digital Operations.

The operator-facing catalog and `./alz account-factory list` expose:

- `./alz account-factory inspect adaptcloud-admin`: Verify the current Identity Center administrator role and management account, read-only.
- `./alz account-factory prepare adaptcloud-admin ALZ-DEV-01 UNIQUE_ACCOUNT_EMAIL OWNER_EMAIL OWNER_FIRST OWNER_LAST .runs/account-factory/dev-proposal.json`: Verify real AWS Organizations, existing landing zone, Workloads OU and baseline, and discover Service Catalog Account Factory product, path and provisioning schema. Save a private, short-lived, SHA-256-bound plan. No cloud writes.
- `./alz account-factory submit adaptcloud-admin .runs/account-factory/dev-proposal.json .runs/account-factory/dev-submission.json`: A trusted human terminal, exact plan-hash confirmation and explicit owner billing authorization are required. No agent-triggered submission. Writes an intent marker before the bounded Service Catalog call to prevent blind retries.
- `./alz account-factory status adaptcloud-admin rec-RECORD_ID`: Read the actual asynchronous provider record status, which is *not* proof that Control Tower governance finished.
- `./alz account-factory verify adaptcloud-admin ALZ-DEV-01 UNIQUE_ACCOUNT_EMAIL`: independently read back ACTIVE member account ID, direct Workloads OU membership and succeeded Workloads baseline. This does **not** yet verify per-account Control Tower enrollment, budget alerts, cost authorization or release readiness.

These commands use a **distinct authorized administrator SSO profile** in an administrator-only operator function. They do not widen the generic tool broker or leak profile session material into models. The terraform pilot's four short-lived OIDC identity roles remain separate. Infrastructure ACT remains DISABLED.

Financial authorization is not satisfied merely by a typed phrase: the owner must independently review cost exposure, account-email custody, ownership and available credits/budget alerts. The existing $80 cumulative internal pilot bound is **not** a hard AWS spending limit and must not be generalized to customers.

## GitLab and GitHub portability

The runtime must be repository-host neutral. It does not call GitHub APIs, use GitHub Actions workflow names or assume GitHub OIDC subject format for Account Factory authentication. Use the source commit and artifact SHA-256 as portable evidence identifiers, and store approval and customer evidence outside the source repository. The named AWS administrative SSO profile is configured on the authorized execution host, not stored in Git.

When cloned to GitLab, review protected branches, protected deployment environments, required approvals, protected runners, secret storage, artifact retention and the real **GitLab ID token issuer, audience and subject**. Do not copy GitHub OIDC trust conditions to GitLab; separately establish and test exact short-lived DISCOVERY/STATE/STATE_WRITE/APPLY subjects on the approved host before Terraform ACT.

## Remaining acceptance work

Offline unit tests exercise success and fail-closed paths with injected AWS responses. The live Mac session binding, real AWS Account Factory Product/Artifact/Path discovery, account creation, cross-account verification, Studio authentication, multi-user authorization and customer delivery UX are **not demonstrated** by these tests. Do not claim completed account creation or production readiness; QA/PROD require their own approvals, policies and independent account evidence.

The current runtime binds the organization's specific internal management account and OU; before a customer deployment those must become tenant-scoped immutable, policy-reviewed configuration, not assumed universal values. Existing authorized account creation is a separate governance action and does not imply broad workload ACT.
