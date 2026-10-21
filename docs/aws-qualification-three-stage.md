# AWS accelerator qualification: DEV / STAGING / PROD

Status: **Engineering test runbook**, not customer-cloud release acceptance. Milestone 1 infrastructure ACT remains disabled.

## Three-stage contract

Treat DEVELOPMENT, STAGING, and PRODUCTION as first-class **distinct** environments. In an independently authorized AWS engineering organization, use separate member accounts and roles for each stage, plus a management account used solely for Organizations administration. An `ALZ-PROD-TEST` account may hold production-like policy **without hosting customer production workloads**; it is not a production release qualification target.

For every stage, bind: environmentId, tenant, provider, target account, region, residency, trusted-host identity reference, capability, state/checkpoint namespace and source-bound evidence. Never infer PROD from missing stage, reuse a DEV token in PROD, share account state, or automatically promote an artifact.

## Commands: existing governed member account (read-only)

These commands work in an authorized CloudShell session with AWS CLI v2. They do **not** authorize ALZ access or change AWS resources. Use the existing profile; don't run `aws configure sso` within CloudShell merely to repeat console login. Never paste account IDs, ARN, token, credentials, policy bodies or inventory records into public issues.

```bash
# Show only status and non-sensitive summary data.
aws sts get-caller-identity --query 'Account' --output text >/dev/null && echo 'STS: PASS'
echo "Region: ${AWS_REGION:-${AWS_DEFAULT_REGION:-unset}}"
aws organizations describe-organization --query 'Organization.FeatureSet' --output text

# These may return AccessDenied; classify DENIED/UNKNOWN rather than ABSENT.
aws organizations list-roots --query 'length(Roots)' --output text
aws controltower list-landing-zones --region us-east-2 --query 'length(landingZones)' --output text

# Account-and-region-scoped posture and inventory probes.
aws ec2 describe-vpcs --region us-east-2 --query 'length(Vpcs)' --output text
aws configservice describe-configuration-recorders --region us-east-2 --query 'length(ConfigurationRecorders)' --output text
aws cloudtrail list-trails --region us-east-2 --query 'length(Trails)' --output text
```

Each command is a **standalone test**. An AccessDenied response is valuable denial-path evidence. Do not aggregate failed inventory calls into an empty inventory or assert Control Tower is absent. Do not change the existing SCP or try alternate credentials to evade an organizational policy. Request read-only access changes only via authorized organization governance.

## Commands: independently owned test organization (once legitimately provisioned)

```bash
# Execute only in the separately authorized management-account administrative profile.
aws organizations list-roots --query 'length(Roots)' --output text
aws organizations list-accounts --query 'length(Accounts)' --output text
```

Do not create/move/delete member accounts, enable controls or deploy Control Tower as part of this verification. Explicit stage-specific read-only role sessions are independently validated with `aws sts get-caller-identity`; store identifiers in a customer-owned, redacted evidence vault rather than GitHub text.

## Repository / local accelerator tests (on the ALZ checkout, not CloudShell)

```bash
npm ci
npx tsx --test test/environment-binding.test.ts test/environment-binding-matrix.test.ts
npm run test:node
./alz doctor
./alz inspect aws
```

`./alz inspect aws` is a separate runtime operation. Run it only when host-scoped, approved AWS read-only credentials are configured; unlike isolated unit tests, it may query actual cloud APIs. This command is **not** part of an automated PROD run. Never infer native build qualification from the existing fixture-generated `runBuildLoop()`.

## Acceptance evidence

| Gate | Positive expectation | Negative expectation |
| --- | --- | --- |
| Stage identity | DEV, STAGING, PROD each bind uniquely | stage omissions, lowercase alias `prod`, cross-stage identity reuse denied |
| Tenant / account | Exact tenant and target match | cross-tenant or cross-account handoff denied |
| Capability | DISCOVER/ASSESS/DESIGN/PREVIEW/OPERATE only | ACT or undeclared capability denied |
| Governance | Explicit allowed reads return source-bound records | AccessDenied / explicit SCP DENY preserved as UNKNOWN, not missing resource |
| IaC | Actual toolchain validation and scoped preview recorded separately | fixture or unsigned evidence cannot qualify real Build |
| Promotion | Independent reviewer and bound artifact/destination | no implicit DEV→STAGING→PROD promotion |
| Release | Authentic target-runtime, CI, security and independent approvals | production release HOLD until #39/#77 acceptance |

CloudShell observations received on 2026-10-21: authenticated member-account STS; Organizations `FeatureSet=ALL`; `ListRoots` denied; `GetHomeRegion` and `ListLandingZones` explicitly SCP-denied in `us-east-2`. User-provided observations only, not ALZ adapter-executed evidence. See #39 for source-bound release ledger.
