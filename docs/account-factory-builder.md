# Sovereign ALZ Builder — customer-first Account Factory workflow

## Eligible practice roles and customer-specific prerequisites

Every practitioner in **Modern Platforms Presales**, **Modern Platforms Delivery**, **Digital Presales** and **Digital Delivery** is eligible to create a governed DEV account when the individual's customer-specific AWS authorization, owner approval and financial authorization are verified. Neither a job title nor a selection in the ALZ interface automatically grants AWS permissions.

| Practitioner | Role-specific prerequisites | Outcome and handoff |
| --- | --- | --- |
| Modern Platforms — Presales | Customer sponsor approves DEV demo; architecture, governance and scope reviewed | Customer-specific platform blueprint and delivery handoff |
| Modern Platforms — Delivery | Customer scope, account purpose, OU, governance controls and platform owner accepted | Verified account evidence and Digital Operations handoff |
| Digital — Presales | Customer permits DEV demo/data; workload design and platform alignment reviewed | Digital solution blueprint, security boundaries and cost assumptions |
| Digital — Delivery | Customer approves workload design, identity and data classification; accountable owner assigned | Verified digital DEV environment and operational handoff |

**Shared prerequisites:** an individually authenticated, non-root, customer-authorized AWS Account Factory execution identity; actual Service Catalog access; correct customer organization, Control Tower and governed OU; unique customer-controlled account email and named Identity Center owner; explicit account/cost authorization; exact request review; independently verified ACTIVE member account, OU and baseline; named monitoring, recovery, finance and support owners. QA and PROD have separate permissions and approvals. A budget alert is not a spending cap.

The Operations area of the existing ALZ Builder shows **Start a customer DEV environment**, a practice-role selector, and the role-specific prerequisites and handoff. Role selection is a recorded **declaration, not authorization**. The generic browser job runner still cannot provision; it provides the existing authenticated administrative handoff path.

Customer differentiation must come from *observed* organization controls, unique account, architecture, required guardrails, permitted data, region, cost owner, and independent account/infrastructure evidence. Do not reuse client evidence, credentials, or grants across customers.

## Delivery journey and current commands

The customer-oriented journey is: customer intake → authenticated discovery → account plan → human approval and finance check → provision with existing Control Tower → independently verify governed account → handoff to Digital Operations.

The operator-facing catalog and `./alz account-factory list` expose:

- `./alz account-factory inspect adaptcloud-admin`: Verify the current Identity Center administrator role and management account, read-only.
- `./alz account-factory prepare adaptcloud-admin MODERN_PLATFORMS_DELIVERY ALZ-DEV-01 UNIQUE_ACCOUNT_EMAIL OWNER_EMAIL OWNER_FIRST OWNER_LAST .runs/account-factory/dev-proposal.json`: Verify real AWS Organizations, existing landing zone, Workloads OU and baseline, and discover Service Catalog Account Factory product, path and provisioning schema. Save a private, short-lived, SHA-256-bound plan. No cloud writes.
- `./alz account-factory submit adaptcloud-admin .runs/account-factory/dev-proposal.json .runs/account-factory/dev-submission.json`: A trusted human terminal, exact plan-hash confirmation and explicit owner billing authorization are required. No agent-triggered submission. Writes an intent marker before the bounded Service Catalog call to prevent blind retries.
- `./alz account-factory status adaptcloud-admin rec-RECORD_ID`: Read the actual asynchronous provider record status, which is *not* proof that Control Tower governance finished.
- `./alz account-factory verify adaptcloud-admin ALZ-DEV-01 UNIQUE_ACCOUNT_EMAIL`: independently read back ACTIVE member account ID, direct Workloads OU membership and succeeded Workloads baseline. This does **not** yet verify per-account Control Tower enrollment, budget alerts, cost authorization or release readiness.

The proposal records the selected practitioner role inside the SHA-256-bound plan with classification `DECLARED_NOT_AUTHORIZING`. These commands use a **distinct authorized administrator SSO profile** in an administrator-only operator function. They do not widen the generic tool broker or leak profile session material into models. The terraform pilot's four short-lived OIDC identity roles remain separate. Infrastructure ACT remains DISABLED.

Financial authorization is not satisfied merely by a typed phrase: the owner must independently review cost exposure, account-email custody, ownership and available credits/budget alerts. The existing $80 cumulative internal pilot bound is **not** a hard AWS spending limit and must not be generalized to customers.

## GitLab and GitHub portability

The runtime must be repository-host neutral. It does not call GitHub APIs, use GitHub Actions workflow names or assume GitHub OIDC subject format for Account Factory authentication. Use the source commit and artifact SHA-256 as portable evidence identifiers, and store approval and customer evidence outside the source repository. The named AWS administrative SSO profile is configured on the authorized execution host, not stored in Git.

When cloned to GitLab, review protected branches, protected deployment environments, required approvals, protected runners, secret storage, artifact retention and the real **GitLab ID token issuer, audience and subject**. Do not copy GitHub OIDC trust conditions to GitLab; separately establish and test exact short-lived DISCOVERY/STATE/STATE_WRITE/APPLY subjects on the approved host before Terraform ACT.

## Remaining acceptance work

Offline unit tests exercise success and fail-closed paths with injected AWS responses. The live Mac session binding, real AWS Account Factory Product/Artifact/Path discovery, account creation, cross-account verification, Studio authentication, multi-user authorization and customer delivery UX are **not demonstrated** by these tests. Do not claim completed account creation or production readiness; QA/PROD require their own approvals, policies and independent account evidence.

The current runtime binds the organization's specific internal management account and OU; before a customer deployment those must become tenant-scoped immutable, policy-reviewed configuration, not assumed universal values. Existing authorized account creation is a separate governance action and does not imply broad workload ACT.
