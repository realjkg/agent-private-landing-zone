# Deploying the cost baseline

The AWS cost baseline (`src/design/cost.ts` configuration, `src/build/cost-baseline.ts` renderer) goes through the same workflow as every pilot project: build, `./alz apply prepare`, `seal`, `approve`, `apply`, then observe with `./alz cost status`. There is no separate path, gate, approval or authority. ACT stays DISABLED unless the owner's reviewed contract authorizes it (`docs/act-pilot-apply.md`, "The contract is the authorization"), and the contract's `limits` decide what a seal admits (`docs/act-pilot-apply.md`, "Provisioning limits"). The repository ships no contract.

Status: the build's preview driver, the project writer and `prepare` are covered by synthetic tests (`test/cost-project.test.ts`). The whole journey runs against emulated AWS in an opt-in suite (`test/cost-baseline-emulated-aws.test.ts`, see "What the emulated journey shows"). Nothing here has run against a real AWS account. That is the owner's supervised DEV run.

## 1. Build and preview (trusted host)

Write the configuration first: copy `config/cost.example.json` to `config/cost.json` and fill in your values. The file is git-ignored because it holds recipient addresses. Then run the build with the cost scenario. It uses the same host, models, environment variables and read-only AWS identity as the first scenario (`docs/private-model-build.md`):

```sh
ALZ_ALLOW_REAL_PRIVATE_BUILD=1 \
ALZ_ALLOW_TERRAFORM_PLAN=1 \
TF_VAR_aws_region=<home-region> \
node dist/cli/real-private-build.js --live-aws-read-only --scenario cost-baseline
```

- **The models.** The two private models may only confirm the values in `config/cost.json`. Fixed code renders the Terraform.
- **The preview.** The driver is the one the log-group scenario uses (`src/build/terraform-preview.ts`): `init -backend=false`, `fmt -check`, `validate -json`, `plan -refresh=false -lock=false` and `show -json`, in a new run folder. It never runs `apply`. The folder starts with the reviewed provider lock (`qualification/aws/act-dev1-canary/.terraform.lock.hcl`, hashicorp/aws 6.68.0 with HashiCorp's hashes), so `init` installs only that package.
- **The check.** The plan must be create-only. Its created addresses must equal the rendered set exactly, or the build stops with `ACTUAL_TERRAFORM_PREVIEW_UNVERIFIED`.
- **Refusals before inference.** A missing `config/cost.json` stops the build with `COST_CONFIG_MISSING`. An invalid one stops it with `COST_CONFIG_INVALID`. Neither costs any inference.

## 2. The project it writes

Only when every gate passes does the build write the project. It goes to `.runs/qualification/real-private-build/<run-id>/project/`, which is git-ignored, next to the run's evidence, and the command prints the path. The folder has the committed AWS canary's shape (`qualification/aws/act-dev1-canary`):

| File | What it is |
| --- | --- |
| `main.tf` | The same resources as the preview, line for line (`renderAwsCostBaselineProject`). Three things differ from the preview: an empty `backend "s3" {}`, which the product's backend override replaces at seal; the canary's `unit_tags` variable; and `default_tags` in both the home and the `billing` (us-east-1) provider, which merge `var.unit_tags`. |
| `.terraform.lock.hcl` | The reviewed lock, byte for byte. |
| `terraform.tfvars.example.json` | `aws_region` (the build's home region) and `unit_tags` with placeholders. |
| `cost-baseline.json` | The render record, labeled `LOCAL_RENDER`: the main.tf hash, the preview artifact hash it came from, the config hash, every resource it creates with its region, the cross-region dependency and the prerequisites. Terraform does not read it. |

The writer refuses an existing folder, so nothing is overwritten. It runs no engine and reads no cloud.

## 3. Prepare, seal, approve, apply

Same steps as for the canary (`docs/act-aws-terraform-execution-brief.md`), with `--project` pointing at the folder above:

1. Copy `terraform.tfvars.example.json` to `terraform.tfvars.json` in the project folder.
2. Run `./alz apply prepare --environment DEV --project <project folder>`. Copy the three unit tags it prints into `unit_tags`, then run `prepare` again. Use the files from the second run.
3. Run `seal`, `approve` and `apply`, as in `docs/act-pilot-apply.md`, "Commands".

The contract's DEV target names `limits`, not `canary`. Start from `config/act-pilot-contract.aws-dev-limits.example.json`, which lists every type the renderer can emit. It also lists `us-east-1` beside the home region, because Data Exports is served from there. A type the limits leave out, a count over its `max`, or a region outside `regions` is refused at seal with `RESOURCE_NOT_IN_LIMITS`. Nothing is then sealed or applied, and no approval is consumed. If you encrypt the alert topic (`notifications.encryption: CUSTOMER_KMS`), add `aws_kms_key` to the limits; the example does not list it.

## 4. Observe

Run `./alz cost status`. It reads the budget, the alerts, the unit's tags and the export, read-only. It saves the result for readiness and for the console's Cost and visibility panel. Expect `WAITING` on the first day: a new budget has no calculated spend yet, and the first CUR 2.0 delivery can take up to 24 hours. Neither one ever reads as zero spend. A budget tracks spend and sends alerts; it never caps spend.

## What the emulated journey shows

`test/cost-baseline-emulated-aws.test.ts` is opt-in and labeled EMULATED. It needs `ALZ_SIM_TERRAFORM`, `ALZ_SIM_MOTO` and `ALZ_SIM_AWS_PROVIDER_DIR`; its header has the setup. It runs, with the real Terraform engine and HashiCorp's real aws provider 6.68.0: the build's preview driver; the project writer; `prepare`, twice; a refused seal under limits that leave out `aws_sns_topic_subscription`; and a seal, approval and apply under the example's limits. Then it runs `readCostStatus` through a reader that sends each cost read to the emulator. It is never provider qualification, live acceptance or release evidence.

| What | Served by |
| --- | --- |
| STS, S3 (state with `use_lockfile`, the export bucket and its policy, lifecycle, encryption, ownership and public access block), S3 Control, SNS, the tagging API | moto |
| AWS Budgets: subscribers and resource tags | A test-only in-memory stub (`test/helpers/cost-emulator.cjs`). moto 5.2 implements only budget create, describe and notifications. |
| AWS Data Exports (`bcm-data-exports`) | The same stub. moto has no Data Exports service. The stub's export never delivers. |
| Cost Explorer `ListCostAllocationTags` | Nothing. moto has no such call, so the status reports it `UNKNOWN`, and the test asserts that. |
| The Terraform registry protocol | Answered locally, from HashiCorp's release files the operator downloaded. Terraform checks the signature and the lock's hash. |

It does not show how Budgets, Data Exports or Cost Explorer really behave. Nor does it show IAM, real latency, or whether the owner's account accepts the export (management versus member account). Those points belong to the owner's live run.
