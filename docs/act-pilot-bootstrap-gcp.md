# Pilot bootstrap for GCP: project owner runbook

Status: **offline-validated only; unverified until a project owner runs it.**

On 2026-10-27, `bootstrap/gcp` was checked with Terraform 1.16.4 (binary sha256 `44d3683c2ac9d72b6ca8ad880a2df8dd956dd5e019b1d111cb6a5d914d576b73`), `hashicorp/google` 8.8.1 and no cloud credentials:
- `terraform fmt -check -recursive`, `init -backend=false` and `validate` passed, with no warnings;
- `terraform test` passed all 20 runs against a **mocked** `google` provider (`bootstrap/gcp/tests/bootstrap.tftest.hcl`).

That confirms the resource and attribute names against that provider schema, and this package's own logic: names, grants, conditions, validations and outputs. Nothing more. No `plan` or `apply` has run against Google, no resource has been created, and the IAM, workload identity federation, Cloud Storage and deny-policy behavior is untested.

The provider zip came from `releases.hashicorp.com`. Its SHA256SUMS entry matched, but the signature on SHA256SUMS was **not** verified: the HashiCorp key import failed in the sandbox. Rerun `terraform init` against the registry on your own machine.

The GCP release-path PLAN (owner approval 6433121154 on issue #39) and the G0 package (`docs/act-pilot-gcp-terraform-g0.md`) define what this package provisions. This is slice S2. Like `bootstrap/aws` and `bootstrap/azure`, it is owner-run and separate from the pilot apply:
- nothing under `src/` references it;
- `./alz apply` never runs it;
- it never enables ACT;
- the contract stays `enabled: false`, and its pin stays empty.

GCP is not yet an admitted provider: until the authorization lane adds it, a contract naming GCP is refused.

## What it creates

One run per project and engine. Pick the engine with `engine`.

| | TERRAFORM (path 5) | GCP_API (path 6) |
| --- | --- | --- |
| Environments | DEV, QA and PROD, one project each | DEV only |
| Service accounts | `<prefix>-<env>-discovery`, `-state`, `-state-write`, `-apply` | `<prefix>-dev-api-discovery`, `<prefix>-dev-api-apply` |
| Workload identity pool | `<prefix>-<env>`, provider `oidc` | `<prefix>-dev-api`, provider `oidc` |
| APPLY workload grant (custom role on the project) | `pubsub.topics.create`, `.delete`, `.get`, `.update` | `pubsub.topics.create`, `pubsub.topics.delete` |
| DISCOVERY workload grant | `pubsub.topics.get`, `cloudasset.assets.searchAllResources` | `pubsub.topics.get` |
| State bucket | yes, in the environment's project | none, and no bucket grant |
| STATE | bucket only: read the state prefix; create and delete the `.tflock` object only | n/a |
| STATE_WRITE | bucket only: read and write the state prefix | n/a |
| Project guardrails | org policy `iam.disableServiceAccountKeyCreation`; an IAM deny policy | the same, its own deny policy |

The minimal workload is one labeled Pub/Sub topic in the DEV project. Terraform needs `get` and `update` on top of create and delete, because it reads the topic back after creating it and can change its labels. Path 6's engine needs exactly what it named in #303.

**Identities are engine-neutral.** Both engines use the same variables:
- `ALZ_<IDENTITY>_GOOGLE_APPLICATION_CREDENTIALS`
- `ALZ_<IDENTITY>_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT`
- `ALZ_<IDENTITY>_GOOGLE_PROJECT`
- `ALZ_<IDENTITY>_GOOGLE_REGION`

Each engine still gets its own service accounts, pool, custom roles and deny policy, so a GCP_API identity never holds a TERRAFORM grant. Path 6's engine never touches Terraform state, and its accounts have no access to the state bucket.

**Workload identity federation, never a key.**
- Each service account has one `roles/iam.workloadIdentityUser` binding, for the pool principal of exactly one subject (`principal://iam.googleapis.com/<pool>/subject/<subject>`).
- The provider's attribute condition admits only the engine's subjects.
- No key is created, and the org policy forbids creating one.
- The package outputs one credential configuration per identity: an `external_account` file source with no key, no token and no `service_account_impersonation_url`. That is exactly the shape the provider spec (`src/apply/providers/gcp.ts`) accepts.

**State bucket (TERRAFORM).**
- Uniform bucket-level access and public access prevention are on, and versioning is on.
- One lifecycle rule deletes a noncurrent version only once at least `noncurrent_versions_kept` newer versions exist (default 10) and it has been noncurrent for `noncurrent_version_retention_days` (default 90).
- The bucket name must be dotless, matching the provider spec.
- STATE's and STATE_WRITE's grants are on the bucket only, under IAM Conditions on the object name (UNVERIFIED, G-4).

**Deny guardrails** (`deny_pilot_guardrails`, default on).
- APPLY and DISCOVERY are denied every Cloud Storage object permission in the project. Neither can become a state fallback, whatever role it is later given.
- APPLY is also denied editing the pilot's service accounts, pool, custom roles and the project IAM policy. This is the GCP form of the AWS bucket policy's "deny everyone else" and of `DenyEditingBootstrapIdentity`.
- If a reviewed blueprint must write objects, turn it off for that project and say so in the change record.

**Owner items, off by default** (`docs/act-pilot-gcp-terraform-g0.md`, proposals):
- **P3** `lock_version_retention_days`: a rule that deletes noncurrent `*.tflock` versions after N days. It matches the suffix `.tflock` only, never `.tfstate`.
- **P5** `enable_storage_data_access_logs`: Cloud Storage `DATA_READ` and `DATA_WRITE` audit logs on the project. The qualifier's `SEPARATED` attestation needs them, and they are billed as log volume.

**Budget** (optional): `budget_monthly_usd` plus `billing_account_id` create a `google_billing_budget` on the project, with alerts at 80 and 100 percent.

## Prerequisites: what the project owner needs

- One project per environment: DEV, QA and PROD for TERRAFORM. Path 6 uses the DEV project only.
- On each project: `roles/owner`, or the narrower set needed here:
  - Workload Identity Pool Admin, Service Account Admin, Role Administrator and Project IAM Admin;
  - Storage Admin;
  - Organization Policy Administrator, at the organization or folder, to set the project policy;
  - Deny Admin;
  - Service Usage Admin.
- Billing Account Costs Manager, if you set a budget.
- Terraform 1.10 or later. This package was checked with 1.16.4.
- Your OIDC issuer (GitHub Actions by default) and one subject per identity: `repo:OWNER/REPO:environment:<name>`. Create one GitHub environment per identity and stage, and put required reviewers on STATE_WRITE and APPLY.

## Step 1: TERRAFORM (path 5)

For each of DEV, QA and PROD, in a separate workspace or directory copy:

```sh
cd bootstrap/gcp
cp terraform.tfvars.example dev.tfvars   # edit: environment, project_id, region, subjects, token files, bucket
terraform init
terraform fmt -check && terraform validate
terraform test                           # SYNTHETIC: mocked provider, no Google calls
gcloud auth application-default login    # the owner's own login, never a pilot identity
terraform plan -var-file=dev.tfvars -out=dev.plan
terraform apply dev.plan
```

Read the plan before applying it. Expect:
- four service accounts;
- one pool and one provider;
- the custom roles;
- the bucket and its bindings;
- the org policy and the deny policy.

Expect no service account key and no role on the project for STATE or STATE_WRITE.

## Step 2: GCP_API (path 6), DEV only

Use the DEV project again, with a **separate** state directory, `engine = "GCP_API"`, the two subjects and token files, and no `state_bucket_name`.

If the TERRAFORM run in that project already manages the org policy, set `enforce_no_service_account_keys = false`. Otherwise the policy would be managed twice; it stays enforced either way.

The run creates `<prefix>-dev-api-discovery` and `<prefix>-dev-api-apply`, its own pool, roles and deny policy, and nothing else.

## Step 3: Runner setup

For each identity, write `terraform output -json credential_configurations` entry to a file on the runner:
- mode 0600, outside the working tree;
- one file per identity, never shared.

The runner's OIDC token for that identity must be written to the `token_files` path named in that file. Then set, per identity:
- `ALZ_<IDENTITY>_GOOGLE_APPLICATION_CREDENTIALS`: that file's absolute path;
- `ALZ_<IDENTITY>_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT`, `ALZ_<IDENTITY>_GOOGLE_PROJECT` and `ALZ_<IDENTITY>_GOOGLE_REGION`: from `terraform output -json identity_variables`.

Set no other `GOOGLE_*`, `GCLOUD_*`, `CLOUDSDK_*` or `GCE_*` variable, and never `STORAGE_EMULATOR_HOST`. The provider spec refuses each of them by name.

## Step 4: Fill the configuration

`bootstrap/config.gcp.template.json` shows where each output goes:
- `contract_target` goes into the contract's `targets`;
- the service account emails and file paths go into the `ALZ_<IDENTITY>_*` variables.

Identifiers and paths only. Leave `enabled: false` and the pin empty.

## Step 5: Credential preflight

Run the preflight in a separate shell, never the one that runs `./alz`. Print only the service account email, never a token:

```sh
# As the owner: what each account may do, and that it has no key.
gcloud iam service-accounts keys list --iam-account=<email> --managed-by=user   # expect: empty
gcloud iam service-accounts get-iam-policy <email>                              # expect: one workloadIdentityUser principal

# As the identity, with its configuration alone, a clean environment and a throwaway gcloud configuration (UNVERIFIED flags):
env -i PATH="$PATH" HOME="$(mktemp -d)" CLOUDSDK_CONFIG="$(mktemp -d)" sh -c \
  'gcloud auth login --cred-file=<config> --quiet >/dev/null &&
   gcloud auth print-access-token --impersonate-service-account=<email> >/dev/null && echo "impersonated <email>"'
```

Delete the throwaway configuration directory afterward.

Then check the separation:
- STATE can read `<prefix>/default.tfstate`.
- A write of any other object as STATE must be denied.
- Any object access as APPLY or DISCOVERY must be denied.

## Failure handling

- **The token exchange is refused** (`invalid_grant` or `unauthorized_client`). Compare the token's `iss`, `sub` and `aud` with the provider's issuer, attribute condition and allowed audiences. Fix the subject in the tfvars and re-apply. Never widen the condition to a wildcard: the validation refuses `*`.
- **Impersonation is denied** (`iam.serviceAccounts.getAccessToken`). The `workloadIdentityUser` binding names a different subject than the token carries.
- **A held lock.** The lock is the object `<prefix>/default.tflock`. The pilot never runs `force-unlock`. As the owner, after confirming no apply is running, delete that one object with your own credentials.
- **The deny policy rejects a permission name.** The names in `guardrails.tf` are from memory (UNVERIFIED). Check them against Google's list of permissions supported in deny policies, then correct the name. Do not remove the rule.

## Teardown

1. Remove the runner's credential configuration and token files.
2. Run `terraform destroy` per project. For TERRAFORM, set `force_destroy_state = true` once, apply, then destroy.

Custom roles are soft-deleted for about 7 days, and a pool for about 30. Recreating one with the same id inside that window fails; undelete it or choose another `name_prefix`.

## Assumptions not verified

- **Provider schema.** Checked offline only, against `hashicorp/google` 8.8.1. Other versions inside `>= 8.0, < 9.0` may differ.
- **G-1.** The `google` provider and the `gcs` backend honor an `external_account` file-source configuration through `GOOGLE_APPLICATION_CREDENTIALS`, with impersonation from `GOOGLE_IMPERSONATE_SERVICE_ACCOUNT` and the backend's `impersonate_service_account`.
- **`roles/iam.workloadIdentityUser`** is sufficient for a federated principal to impersonate the account through `generateAccessToken`, without `roles/iam.serviceAccountTokenCreator`.
- **G-4.** IAM Conditions on `resource.name` for Cloud Storage objects hold under uniform bucket-level access. A list call is judged against the bucket, which the conditions admit.
- **Deny policies.** The `storage.googleapis.com/objects.*`, `iam.googleapis.com/...` and `cloudresourcemanager.googleapis.com/projects.setIamPolicy` permission names are supported in deny policies.
- **Permissions.** `pubsub.topics.create`, `.delete`, `.get` and `.update` are enough for the Pub/Sub topic workload, and `cloudasset.assets.searchAllResources` for the unit sweep.
- **Billing budget.** The budget API may require a quota project for the owner's login (`gcloud auth application-default set-quota-project`).
