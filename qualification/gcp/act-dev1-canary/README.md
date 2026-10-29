# ACT-DEV-1 GCP Terraform canary

The GCP counterpart of the AWS Terraform canary in [`../../aws/act-dev1-canary`](../../aws/act-dev1-canary) and the Azure one in [`../../azure/act-dev1-canary`](../../azure/act-dev1-canary). It creates **one Pub/Sub topic** and nothing else: no subscription, no message, no schema, no customer-managed key (CMEK), no IAM binding. A topic with no subscription and no published message has no billable workload. Path 5 (GCP Terraform) is admitted for DEV only (#339).

This folder is an EXAMPLE. Nothing in it enables ACT. The reviewed pilot contract, approvals and every gate in [`docs/act-pilot-plan.md`](../../../docs/act-pilot-plan.md) still apply. The owner's evidence checklist for this path is [`docs/act-pilot-gcp-evidence.md`](../../../docs/act-pilot-gcp-evidence.md).

## Pins

- `hashicorp/google` exactly `= 8.9.0`, the version the pilot's denied-type and data-source lists were reviewed against (`GCP_DENIED_TYPES_REVIEWED_AGAINST`, `src/apply/providers/gcp.ts`).
- `.terraform.lock.hcl` pins that one provider with HashiCorp's `h1:` hashes for `linux_amd64` and `darwin_arm64` (the values in `OFFICIAL_PROVIDER_HASHES`, `src/apply/lockfile.ts`). Lane G1 wrote it with `terraform providers lock` (Terraform 1.16.4) from the release zips. Those zips were checked against the `SHA256SUMS`, which carries a good HashiCorp signature (key `C874 011F 0AB4 0511 0D02 1055 3436 5D94 72D7 468F`). Keep it unchanged.
- `backend "gcs" {}`: the product supplies the bucket, prefix and STATE_WRITE settings at init. Credentials come from the identity's `GOOGLE_*` variables (workload identity federation only), never from the project.
- `provider "google"` names the project as a **constant**. The seal refuses a project that is an expression or another project's id (review N1 of #339). It also refuses a provider block that sets credentials, a token, impersonation, scopes, an endpoint or a billing override.

## The one value written into the project

Copy this folder **outside the repository checkout** (for example `cp -r qualification/gcp/act-dev1-canary ~/act-dev1-gcp`). Seal, qualify, apply and cleanup refuse a checkout with uncommitted changes, and the driver refuses any extra Terraform override file by name. In the copy, replace `examplefake-dev` in the provider block with the contract's DEV `projectId`, exactly as the reviewed contract states it. This is the only edit to `main.tf`. If the value is not the contract's project, the seal stops with `PROVIDER_ACCOUNT_NOT_IN_CONTRACT`, and nothing runs. Then pass the copy to `./alz apply prepare --environment DEV --project <copy>`.

## Inputs the operator supplies

In the copy, copy `terraform.tfvars.example.json` to `terraform.tfvars.json` and replace each example value. (In this folder, Git and the image build ignore `terraform.tfvars.json`, state and plan files.)

| Variable | Rule |
| --- | --- |
| `region` | The contract's DEV `region`, for example `europe-west4`. It becomes the topic's only allowed storage region. |
| `canary_name` | `alz-act-dev-1-<name>`. Use a new name for each run. |
| `owner` | The approved owner label: lowercase letters, digits, `_` and `-`. |
| `unit_labels` | Exactly `alz-managed-by`, `alz-unit` and `alz-build`, with the values `./alz apply prepare` prints. They go into the provider's `default_labels`, so every resource the run creates carries them. |

## What the seal checks on this topic

On top of the canary allowlist (exactly one `google_pubsub_topic`, create only), the judge refuses these (lane G1, R1 and R2 of the #339 follow-ups). It checks them at seal and again when the apply re-derives the plan:

- `kms_key_name`, `schema_settings`, `ingestion_data_source_settings`, `message_transforms`, `message_retention_duration` (any value) or `tags`, whether configured, planned or unknown until apply: `CANARY_ATTRIBUTE_NOT_IN_CONTRACT`.
- `deletion_policy` other than the default `DELETE`: `CANARY_ATTRIBUTE_NOT_IN_CONTRACT`.
- A `message_storage_policy` that is absent, unknown, or anything other than exactly the contract's region: `LOCATION_NOT_IN_CONTRACT`.

## Expected preview

Exactly **1 create**: `google_pubsub_topic.act_dev1`. Anything else means a changed project or the wrong target. Stop and do not approve.

## Read-back to verify after apply

`./alz apply observe --sealed SEALED_PLAN` reads the topic as DISCOVERY through Google's REST API (`GCP_REST`). It confirms that the topic exists by its exact name, and sweeps the project's resources for the unit label. The reader can also compare `messageStoragePolicy.allowedPersistenceRegions` with the contract's region (a mismatch is never `VERIFIED`). Wiring that comparison into `observe` waits for lane AZ-1's location check (#343). Until then, the owner reads the policy in E7 of the evidence checklist. This checks one Pub/Sub property. It is **not** a data-residency claim for the topic, the project or Google's processing.

What the topic must show:

- the name `projects/<project>/topics/<canary_name>`;
- the labels `environment=dev`, `managed-by=sovereign-alz`, `purpose=act-dev-1`, `owner=<owner>`, the three unit labels, and `goog-terraform-provisioned=true`, which the provider adds;
- no subscription, no schema, no KMS key, no message retention.

## Cleanup

The governed cleanup deletes the topic, the only resource the run created. The state bucket is protected (`PROTECTED_BACKEND`), and the project is never touched. After cleanup, `./alz apply verify-cleanup --proposal PROPOSAL.json` must report the topic `CONFIRMED_DELETED`. If a person deletes the topic by hand instead, rerunning `./alz apply observe --sealed SEALED_PLAN` reports the topic missing and the observation `FAILED`, which is the expected result for an absent topic (see the evidence checklist).

## Tests

`test/act-dev1-gcp-canary.test.ts` (SYNTHETIC) checks the files: one resource block, the pin, the provider settings, the single lock entry with the official hashes, and the same lock and input readers that `./alz apply prepare` uses. With `ALZ_CANARY_TERRAFORM` (the pinned Terraform) and `TF_CLI_CONFIG_FILE` (an offline google 8.9.0 mirror), it also runs `fmt -check`, `init -backend=false -lockfile=readonly` and `validate`.

`test/apply-emulated-gcp.test.ts` (EMULATED, opt-in) seals and applies this canary through the real driver with the real Terraform and the real, signature-verified google 8.9.0 provider. Google's endpoints are replaced by a loopback emulator, so no real project is involved.
