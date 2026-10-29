# ACT-DEV-1 — Owner bootstrap and supervised Terraform canary automation

The code now supports synthetic prequalification, authenticated *read-only* AWS inventory, four distinct OIDC-to-STS identity smoke tests, and strict one-resource Terraform plan inspection. These tools **never** apply Terraform, create an account, sign an approval, mint OIDC tokens, or enable ACT. Real AWS evidence remains an explicit acceptance dependency.

## Prepare locally

Use the existing `./alz` operator installation. The following commands are developer/operator evidence steps, not an alternate deployment channel. Restrict `.runs/act-dev1/` permissions and never check the evidence files or JWTs into Git.

```bash
python3 test/act-dev1-automation.test.py
python3 tests_python/test_aws_dev_terraform_handoff.py
```

### D1: Dedicated governed member account

From the authenticated *management-account read-only session*:

```bash
python3 scripts/act-dev1-readiness.py --phase account \
  --profile adaptcloud-admin --dev-account ACTUAL_DEV_ACCOUNT_ID \
  --ou-id ou-dnkl-3tbf48bv \
  --output .runs/act-dev1/account.json
```

The collector verifies the dedicated ACTIVE member account, direct Workloads OU membership and the Control Tower AWSControlTowerBaseline status. A management-account ID, wrong OU or unverified status fails closed. AWS Account Factory creation remains a separate owner-approved action.

### D2: Budget evidence

```bash
python3 scripts/act-dev1-readiness.py --phase budget \
  --profile adaptcloud-admin --dev-account ACTUAL_DEV_ACCOUNT_ID \
  --output .runs/act-dev1/budgets.json
```

This inventory is deliberately incomplete as a spending authorization: budget alerts are delayed/advisory, subscriptions must be separately confirmed, credits are not independently verified, and no hard USD stop is available. Owner-controlled financial authorization and service/IAM bounds remain mandatory before a billable canary. Existing management-account spending ($14.75 observed earlier) cannot be treated as a DEV cost estimate. The cumulative project ceiling remains **$80**.

### D3: Owner bootstrap and read-back

Only an account owner with dedicated limited-time authority may initialize, review, and apply `bootstrap/aws` in its *own* independent bootstrap state. Generate a proposed resource-scoped IAM policy and review it against AWS's current CloudWatch Logs authorization reference:

```bash
python3 scripts/act-dev1-apply-policy.py \\
  --dev-account ACTUAL_DEV_ACCOUNT_ID \\
  --log-group /alz/act-dev-1/canary-01 --owner APPROVED_OWNER \\
  --output .runs/act-dev1/canary-apply-policy.json
```

The owner creates a *customer-managed policy* in the DEV account after reviewing this file, and binds it to both `apply_managed_policy_arns` and `apply_permissions_boundary_arn`. The reviewed account-owned policy, state administrator principal, DEV account/region, observed exact OIDC subjects and monthly budget are supplied to `bootstrap/aws`. Neither this script nor the generated policy executes IAM actions. The boundary constrains APPLY even if additional managed policies are later attached; IAM/SCP/RCP effective denies still require live tests. Do not use generic ReadOnlyAccess for an APPLY identity. Do not run this module from ACT.

After the owner completes bootstrap, use a DEV-account read-only profile (not an ACT execution-identity fallback):

```bash
python3 scripts/act-dev1-readiness.py --phase bootstrap \
  --profile YOUR_DEV_READ_ONLY_PROFILE --dev-account ACTUAL_DEV_ACCOUNT_ID \
  --bucket ACTUAL_REVIEWED_STATE_BUCKET --state-key pilot/dev.tfstate \
  --oidc-subjects-file .runs/act-dev1/observed-subjects.json \
  --output .runs/act-dev1/bootstrap.json
```

The read-back checks four distinct role ARNs and exact OIDC audience/subject/principal, state bucket ownership/encryption/versioning/public-access controls, and restrictive S3 policy structure. It does **not** prove effective IAM/SCP/RCP denies; collect real denial-path evidence separately. Cross-role and state-lock smoke tests must run against the actual target.

### D4: Four-subject identity delivery

The ACT process never inherits `AWS_PROFILE`, static keys or shared fallback credentials. One ordinary GitHub Actions environment job does not provide four different subjects. Obtain four distinct ephemeral JWT files from an owner-approved trusted host/broker or issuer; all files must be absolute paths, private `0600`, owned by the running user, and bound to exact observed AWS IAM trust conditions.

Create a local `0600` JSON file named `.runs/act-dev1/identity-input.json`:

```json
{
  "environment": "DEV",
  "engine": "TERRAFORM",
  "accountId": "REPLACE_WITH_REAL_DEV_ACCOUNT",
  "managementAccountId": "973471129135",
  "region": "us-east-2",
  "issuer": "https://token.actions.githubusercontent.com",
  "audience": "sts.amazonaws.com",
  "identities": {
    "DISCOVERY": {"roleArn": "REPLACE", "subject": "OBSERVED_SUB", "tokenFile": "/absolute/private/discovery.jwt"},
    "STATE": {"roleArn": "REPLACE", "subject": "OBSERVED_SUB", "tokenFile": "/absolute/private/state.jwt"},
    "STATE_WRITE": {"roleArn": "REPLACE", "subject": "OBSERVED_SUB", "tokenFile": "/absolute/private/state-write.jwt"},
    "APPLY": {"roleArn": "REPLACE", "subject": "OBSERVED_SUB", "tokenFile": "/absolute/private/apply.jwt"}
  }
}
```

Inspecting JWT claims alone is **not** authentication. To call actual AWS STS AssumeRoleWithWebIdentity independently for all four roles and generate only verified role/path bindings:

```bash
unset AWS_PROFILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
python3 scripts/act-dev1-identity.py \
  --config .runs/act-dev1/identity-input.json \
  --output .runs/act-dev1/sts-verified.json \
  --env-output .runs/act-dev1/identity-bindings.sh
source .runs/act-dev1/identity-bindings.sh
```

The bindings contain role ARNs, token *paths* and target region; never JWTs or assumed credentials. Expired, wrong-subject, repeated or insecure files are refused. The approved host is responsible for token renewal and expiry cleanup. This tool verifies successful STS assumptions but cannot prove eventual runtime authorization or effective IAM permissions.

### D5–D7: DEV-only contract, qualification, sealed canary

Use `config/act-pilot-contract.aws-dev.example.json` only as an intentionally disabled example. Populate a genuine dedicated DEV target, a reviewed DEV approver public key, a short approval age and an owner-controlled kill switch. Keep `"embedStateWrite": true`: every Terraform contract must bind STATE_WRITE for the state backend (owner decision 6486426552), and a contract without it does not load.

**How ACT is authorized.** The contract file is the authority. There is no hash pin any more (owner decisions of 2026-10-27, issue #39).
- The contract's `authorize` entry names, per environment, the operations ACT may run: for this path `"authorize": {"DEV": ["APPLY", "CLEANUP"]}`.
- An absent or empty `authorize` keeps ACT disabled. So does `enabled: false`.
- The owner writes `authorize` by hand. It takes effect only in the owner's reviewed commit of `config/act-pilot-contract.json`. No product code, flag, environment variable or agent writes it.
- The product derives the contract's hash and the authorizing entry's hash and binds both into every sealed plan, approval, cleanup proposal and evidence record. It re-checks them before anything is consumed.
- Emptying `authorize`, or creating the kill switch file, stops ACT.
- The repository ships no contract.

```bash
./alz apply preflight --environment DEV
```

The owner can prepare a *disabled* contract draft from actual account and bootstrap read-back rather than retyping target identifiers:

```bash
python3 scripts/act-dev1-contract-draft.py \\
  --account-evidence .runs/act-dev1/account.json \\
  --bootstrap-evidence .runs/act-dev1/bootstrap.json \\
  --approver-id APPROVED_DEV_APPROVER \\
  --public-key-file /private/owner-ed25519.pub \\
  --output .runs/act-dev1/contract.draft.json
```

The draft has `enabled: false`, `embedStateWrite: true`, the committed canary (one `aws_cloudwatch_log_group`) as the target's canary allowlist, and **no `authorize` entry**. It never enables ACT, and it cannot replace the owner's review of the actual Ed25519 public key or its issuance path. QA and PROD are never synthesized.

To enable the DEV pilot, the owner:
1. copies the draft to `config/act-pilot-contract.json` and inspects it;
2. adds the reviewed `policyVersion`;
3. runs `./alz apply contract-check --file config/act-pilot-contract.json` until it reports COMPLETE;
4. sets `enabled: true` and adds `authorize`, in one reviewed commit, only after source-bound acceptance.

The one-resource canary source is `qualification/aws/act-dev1-canary/main.tf`; its only managed resource is a 30-day CloudWatch log group. The owner selects and pins the provider lockfile and captures `terraform show -json` output from a separately reviewed, authentic plan. The optional offline structural gate checks exactly one CREATE, required tags, 30-day retention, target region, and no drift or outputs:

```bash
python3 scripts/act-dev1-canary-plan.py \
  --plan-json .runs/act-dev1/terraform-show.json \
  --name /alz/act-dev-1/canary-01 --owner APPROVED_OWNER \
  --output .runs/act-dev1/canary-structure.json
```

A structural pass is **not approval**. The person must use the ACT driver's ordinary `./alz apply qualify`, `seal`, `approve`, and `apply` commands, including a genuine manifest, signed review, exact target confirmation, state locking and CloudTrail/STS attestation, as described in `docs/act-pilot-apply.md`. Never execute the standalone plan with raw Terraform apply as a substitute for sealed ACT. The user may not leave the canary applied without explicit cost/retention approval.

### D8: Independent evidence closure

Check the exact resource and tags under an independently authenticated DISCOVERY role, the state version and S3 data events, CloudTrail mutation identity, replay and permission-denial outcomes, and delayed actual costs. With fresh owner-provisioned role tokens after the supervised canary, a read-only verifier re-attests four STS sessions but performs the resource query solely under DISCOVERY:

```bash
unset AWS_PROFILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
python3 scripts/act-dev1-verify-canary.py \\
  --identity-config .runs/act-dev1/identity-input.json \\
  --name /alz/act-dev-1/canary-01 \\
  --owner APPROVED_OWNER \\
  --output .runs/act-dev1/canary-readback.json
```

The read-back report does not assert that CloudTrail mutation identity, state serial/version, or billed cost were verified. Those remain independent acceptance checks. Cleanup requires a **separate owner-authorized** deletion/read-back; the ACT driver has no general destroy path. Retention/cleanup disposition must be explicit. Only after the independent record is complete may the exact target/lock/commit/plan/canary earn ACT-DEV-1 acceptance.

## Engineering status

The synthetic tests cover the read-only collectors, identity checks, strict plan, least-privilege generator, disabled contract draft and independent resource read-back. They intentionally use fake STS and cloud responders for negative-path verification, and cannot substitute for the authenticated read-only account and DEV bootstrap observations. No automatic account provisioning, token-minting broker, AWS mutation, ACT enablement or secret material is bundled here.
