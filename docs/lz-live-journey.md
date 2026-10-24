# Live AWS Landing Zone journey — private models, governance and native IaC previews

This operator-driven qualification path connects existing Sovereign ALZ components **without creating an ACT execution route**. The models recommend; the governed tool broker discovers and previews; the operator reviews source-bound evidence. Unlike `scripts/lz-journey-orchestrate.py` (which only checks models and discovery), `src/cli/lz-live-journey.ts` calls the private inference kernel, real AWS discovery, Terraform or CDK validation and engine-native preview in one sequence.

## Before running

- Run from a **clean committed** and packaged Sovereign ALZ checkout with `npm ci && npm run build` completed. Use an approved **dedicated, nonproduction AWS account**, never the management account.
- Pre-stage and start local, loopback-only Qwen3 1.7B, Qwen3 4B, and Mistral Nemo in Ollama. All three must have verified model digests. The runner refuses missing validator/adjudicator participation, ABSTAIN, fixture discovery or partial AWS findings.
- Supply a dedicated short-lived `DISCOVERY` OIDC identity through the existing `ALZ_DISCOVERY_AWS_ROLE_ARN` and `ALZ_DISCOVERY_AWS_WEB_IDENTITY_TOKEN_FILE` mechanism, plus `ALZ_DISCOVERY_AWS_REGION` set to the same region passed to the command. The runner never accepts ambient `AWS_PROFILE` or generic static-key fallbacks. Identity and account binding is verified using AWS STS **before** models or IaC.
- The chosen Terraform/CDK project must already be reviewed and inside the committed repository. Terraform must have its provider lock file and prepared backend; its local `plan -refresh=false` does not demonstrate drift detection. CDK must point to an **existing** stack with no unsupported assets or custom execution side effects. Both toolchains can execute project/provider code: use a sandboxed host and least-privilege credentials, not just source review.
- Confirm the AWS policy configuration (`AGENTIC_SECURITY_POLICY_MODE=OPA` where required), effective Organizations/SCP/RCP/IAM access, allowed region and cost limits separately. An OPA result does not prove AWS effective authorization. Existing AWS discovery covers only configured probes; it is **not** a complete account inventory.

## Terraform — additive preview

```sh
node dist/cli/lz-live-journey.js \
  --instruction "Design a governed AWS landing zone preview with additive changes" \
  --engine terraform --account YOUR_DEV_ACCOUNT_ID --region us-east-2 \
  --workspace qualification/aws/act-dev1-canary --allow-project-code
```

The trusted adapter performs actual `terraform version`, format/validation checks, `plan -input=false -refresh=false -out=.agentic-preview.tfplan`, and local `terraform show -json`. The report hashes the provider lock, native plan and source commit; it does **not** persist raw plan content. Only resource CREATE operations and governance-classified application changes pass the preview gate. No apply is run.

## CDK — existing-stack preview

```sh
node dist/cli/lz-live-journey.js \
  --instruction "Design a governed AWS landing zone CDK preview with additive changes" \
  --engine cdk --account YOUR_DEV_ACCOUNT_ID --region us-east-2 \
  --workspace path/to/reviewed/cdk/app --stack ExistingDevStack \
  --allow-project-code --allow-preview-write
```

CDK synthesis executes application code. The existing adapter validates the template and **creates, describes and deletes a temporary CloudFormation UPDATE Change Set**; the operator must grant a deliberately bounded preview-write role permission and accept the residual risk of a failed cleanup. The runner never executes the Change Set. CDK is **not authorized** for the AWS Terraform-only ACT-DEV-1 pilot.

The existing generic IaC preview adapter uses its configured DISCOVERY identity; it does not prove the independent CHANGESET/APPLY identity separation required for a future production CDK pilot. That remains a separate qualification.

## Outputs and evidence boundaries

Under `.runs/qualification/lz-live-journey/<run-id>/` (private permissions):

- `journey.json` records the source SHA, model digests, observed model roles, typed STS account confirmation, discovered resource fingerprints, design/policy hash, tool version hash, Terraform lock or CDK assembly hash, native preview hash, typed changes and explicit **ACT DISABLED** boundary.
- `inventory.html` is a local static table visualization of stage progress, inventory relationships by type and planned changes. It contains no Javascript and is not an authorized operations console.

Only `REVIEW_REQUIRED` can result from all gates completing. A partially executed journey returns `BLOCKED` with a reason and retained stage evidence. The offline `scripts/lz-journey-evidence.py` collector can be used afterward for **independent reviewed** source-bound evidence reconciliation, but do not attest authenticity on file hashes alone.

Important limitations: this runner automatically invokes **existing model orchestration, AWS discovery and native IaC preview interfaces**, but previews an **operator-reviewed IaC project**, not arbitrary model-generated executable Terraform or CDK. A native preview does not prove infrastructure was deployed or that a fully populated LZ works. The ACT snapshot here is a **non-authorizing pre-ACT evidence boundary**, not a sealed and signed ACT driver artifact. It cannot enable a Terraform/CDK apply, grant IAM, sign approvals or move issue #39 release admission to GO.

For separately human-authorized narrow ACT-DEV-1 Terraform execution, follow issue #199, `docs/act-dev-1.md` and the existing sealed-plan/contract/approval process. Production Preview/Operate admission still requires D3 real model qualification, D4 authentic AWS provider qualification, D5 Azure, D6 repository controls, recovery and consolidated VERIFY.
