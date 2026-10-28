# AWS operator evidence journey — Milestone 1 Preview/Operate

Audience: authorized AWS administrators evaluating ALZ in a **dedicated nonproduction account**. Issue #39 is the release ledger. **ACT remains DISABLED**; this runbook is not release authorization.

## Choose the evidence lane

| Lane | Purpose | Authentication | Evidence meaning |
| --- | --- | --- | --- |
| Offline fixture | Test orchestration without cloud access | None | SYNTHETIC; never D3/D4 qualification |
| Local private model | Test local Qwen/Mistral reasoning | Loopback Ollama | Local inference; not dedicated-target D3 unless target contract is satisfied |
| AWS identity diagnostic | Confirm the account selected in an operator's CLI | AWS SSO profile, if approved | Read-only identity check **only**; not the live-journey credential |
| Governed AWS live journey | Private model + authentic AWS discovery + Terraform/CDK native preview | **Short-lived OIDC DISCOVERY identity** with explicit target binding | Review-required account-scoped evidence; not release GO |

**Important:** The live journey deliberately rejects ambient `AWS_PROFILE` and static-key fallback. A successful `aws sso login` does **not** satisfy its OIDC requirement. Follow `docs/lz-live-journey.md` and the protected provider-qualification workflow for authentic D4 qualification.

## 1. Local prerequisites and baseline

Run on a controlled host with a clean committed ALZ checkout:

```sh
node --version
npm --version
terraform version
ollama --version
ollama list
aws --version
npm ci
npm run build
./alz doctor
./alz models list
./alz models verify
./alz matrix --offline-fixture
```

Required baseline Ollama tags: `qwen3:1.7b`, `qwen3:4b`, `mistral-nemo:12b`. Granite and Nemotron are optional comparison candidates, **not** replacement models for the D3 production gate. Select exact tags reported by `ollama list`; missing candidates are NOT_RUN, never assumed installed. For the dedicated production target, obey `docs/target-preflight.md` (pinned Ollama 0.40.0, model digests, host identity, and policy/source binding). An offline matrix is synthetic; `./alz matrix --live-models` uses real local inference but does not make the IaC preview live.

## 2. Optional AWS SSO identity diagnostic — not the journey

If permitted by the account owner, check which identity a configured CLI profile uses:

```sh
aws configure list-profiles
aws sso login --profile PROFILE_NAME
AWS_PROFILE=PROFILE_NAME aws sts get-caller-identity --output json
```

Compare the account ID and ARN against the intended account. Do not place credentials or token contents in issues, model prompts, or shared logs. This is a separate diagnostic and cannot be substituted for the live journey's OIDC identity.

## 3. Authentic AWS preview — explicit operator authorization required

Use a **dedicated nonproduction member account**, not the Control Tower management account. Supply an approved, short-lived DISCOVERY OIDC identity using `ALZ_DISCOVERY_AWS_ROLE_ARN`, `ALZ_DISCOVERY_AWS_WEB_IDENTITY_TOKEN_FILE`, and `ALZ_DISCOVERY_AWS_REGION`. Bind the expected 12-digit account and region; the runner verifies STS identity. Review the project and its provider lock/backend first. Both Terraform and CDK can execute reviewed project/provider code, so use a sandboxed host and least privilege.

Terraform example (non-executing additive native preview):

```sh
node dist/cli/lz-live-journey.js \
  --instruction "Design a governed AWS landing zone preview" \
  --engine terraform --account YOUR_DEV_ACCOUNT_ID --region us-east-2 \
  --workspace qualification/aws/act-dev1-canary --allow-project-code
```

Terraform uses a native `plan -refresh=false`, not `apply`. It is **not a drift-detection run**. It accepts only governed additive changes and produces source/model/tool/native-plan provenance.

CDK example (requires separate preview-write permission):

```sh
node dist/cli/lz-live-journey.js \
  --instruction "Design a governed AWS CDK preview" \
  --engine cdk --account YOUR_DEV_ACCOUNT_ID --region us-east-2 \
  --workspace path/to/reviewed/cdk/app --stack ExistingDevStack \
  --allow-project-code --allow-preview-write
```

**CDK is not strictly read-only:** its adapter creates, describes, and deletes a temporary CloudFormation UPDATE Change Set. It does **not execute** the Change Set, but creation/deletion are AWS control-plane writes and cleanup can fail. Do not run CDK without an explicitly authorized narrowly scoped preview-write identity. CDK is outside the AWS Terraform-only ACT-DEV-1 pilot.

For complete runtime contracts, limitations, and failure handling, see `docs/lz-live-journey.md`. The discovery probes are scoped, **not** a complete AWS account inventory. OPA approval is not proof of effective AWS IAM/SCP/RCP authorization.

## 4. Evidence acceptance

The live runner writes `.runs/qualification/lz-live-journey/<run-id>/journey.json` and local `inventory.html`. Successful gate completion results in `REVIEW_REQUIRED`, **not** RELEASE_READY. Retain source SHA, model digests, target identity, native preview hash, typed changes, scope, timestamps, and any blocked stages. Keep account-sensitive artifacts private; share only reviewed/redacted evidence.

The following remain independent release blockers in Issue #39 until exact-source authentic evidence is retained: D3 dedicated target Qwen/Mistral, D4 protected AWS OIDC/discovery/native preview, D5 Azure, D6 GitHub administration and required security/recovery/consolidated VERIFY. Personal-account results must be labeled **personal-account scope**, never customer/organizational qualification. Do not enable ACT, run apply/deploy/destroy, or mark production GO from a synthetic or partially executed run.

## 5. Guided UX acceptance (not yet claimed complete)

A future nondeveloper wizard should discover installed model tags, explain OIDC identity setup without requesting secrets, display exact account/region and preview side effects, summarize proposed CREATE/UPDATE/DELETE operations, and export private/redacted evidence with actionable remediation. The existing `lz-live-journey` CLI implements a governed sequence but is **not** that interactive wizard.
