# Pilot bootstrap for GCP: project owner runbook

Status: **offline-validated only; unverified until a project owner runs it.**

On 2026-10-29 (lane G1, after the D12 review below), `bootstrap/gcp` was checked with Terraform 1.16.4 (binary sha256 `44d3683c2ac9d72b6ca8ad880a2df8dd956dd5e019b1d111cb6a5d914d576b73`), `hashicorp/google` **8.9.0** and no cloud credentials, inside a network namespace with loopback only. The provider came from a local filesystem mirror holding the release zip, which matched HashiCorp's signed `SHA256SUMS` (good signature, key `C874 011F 0AB4 0511 0D02 1055 3436 5D94 72D7 468F`):
- `terraform fmt -check -recursive`, `init -backend=false` and `validate` passed;
- `terraform test` passed all 36 runs against a **mocked** `google` provider (`bootstrap/gcp/tests/bootstrap.tftest.hcl`).

(The first check, on 2026-10-27, used 8.8.1 and 28 runs.)

That confirms the resource and attribute names against that provider schema, and this package's own logic: names, grants, conditions, validations and outputs. Nothing more. No `plan` or `apply` has run against Google, no resource has been created, and the IAM, workload identity federation, Cloud Storage and deny-policy behavior is untested.

The provider zip came from `releases.hashicorp.com`. Its SHA256SUMS entry matched. The lane could not check the signature (the HashiCorp key import failed in its sandbox), but the #308 reviewer did, independently: `terraform-provider-google_8.8.1_SHA256SUMS.sig` is a **good signature** from "HashiCorp Security" (subkey `374E C75B 4859 1360 4A83 1CC7 C820 C6D5 CD27 AB87`, primary key `C874 011F 0AB4 0511 0D02 1055 3436 5D94 72D7 468F`), and the `linux_amd64` zip matches the signed entry. Rerun `terraform init` against the registry on your own machine anyway.

The GCP release-path PLAN (owner approval 6433121154 on issue #39) and the G0 package (`docs/act-pilot-gcp-terraform-g0.md`) define what this package provisions. This is slice S2. Like `bootstrap/aws` and `bootstrap/azure`, it is owner-run and separate from the pilot apply:
- nothing under `src/` references it;
- `./alz apply` never runs it;
- it never enables ACT;
- the contract stays `enabled: false`, with no `authorize` entry (the contract's `authorize` entry is the ACT switch; there is no pin).

GCP Terraform is admitted in code for DEV only (owner decision 6481421924 on issue #39): a GCP contract must state `"enabledEnvironments": ["DEV"]`, and only the owner's reviewed contract with an `authorize` entry enables ACT for it. The repository ships none.

## What it creates

One run per engine, in the DEV project only. Pick the engine with `engine`. Both GCP paths are admitted for DEV only (#339; owner decision 6481421924), so `environment` accepts `DEV` and nothing else.

| | TERRAFORM (path 5) | GCP_API (path 6) |
| --- | --- | --- |
| Environments | DEV only | DEV only |
| Service accounts | `<prefix>-<env>-discovery`, `-state`, `-state-write`, `-apply` | `<prefix>-dev-api-discovery`, `<prefix>-dev-api-apply` |
| Workload identity pool | `<prefix>-<env>`, provider `oidc` | `<prefix>-dev-api`, provider `oidc` |
| APPLY workload grant (custom role on the project) | `pubsub.topics.create`, `.delete`, `.get` | `pubsub.topics.create`, `pubsub.topics.delete` |
| DISCOVERY workload grant (custom role on the project) | `pubsub.topics.get`, `cloudasset.assets.searchAllResources` | `pubsub.topics.get`, `cloudasset.assets.searchAllResources` (D12) |
| APIs the bootstrap enables (never a runtime identity) | `iam`, `iamcredentials`, `sts`, `pubsub`, `cloudasset`, `storage` | `iam`, `iamcredentials`, `sts`, `pubsub`, `cloudasset` |
| `contract_target` output | `projectId`, `region`, `backend`, `workspace`, `canary` (and `parent` when set) | D9's shape: the same, with `backend = GCP_API_NO_STATE` and `topicPrefix` |
| `contract_settings` output | `embedStateWrite = true`, `enabledEnvironments = ["DEV"]` | `enabledEnvironments = ["DEV"]` |
| State bucket | yes, in the environment's project | none, and no bucket grant |
| STATE | bucket only: read the state prefix; create and delete the `.tflock` object only | n/a |
| STATE_WRITE | bucket only: read and write the state prefix | n/a |
| Project guardrails | org policy `iam.disableServiceAccountKeyCreation`; an IAM deny policy | the same, its own deny policy |

The minimal workload is one labeled Pub/Sub topic in the DEV project. Terraform needs `get` on top of create and delete, because the google provider reads the topic back after creating it and before deleting it (seen in the EMULATED run, `test/apply-emulated-gcp.test.ts`). It does **not** get `update` any more: the canary is create only (owner decision E1), and a cleanup only deletes. Path 6's engine needs exactly what it named in #303. Both paths' DISCOVERY sweep the project's resources for the run's unit label through Cloud Asset Inventory (`listTagged` in `src/observe/gcp-rest.ts`). Without that grant the inventory is `INCOMPLETE` and an observation can never be better than `INCONCLUSIVE`.

**The TERRAFORM contract must set `embedStateWrite: true`** (`contract_settings` output). Without it, `terraform apply <planfile>` fills the gcs backend's credentials from the apply process's own environment, which is APPLY's. The EMULATED run shows APPLY then holds the lock and writes the state. The deny policy below forbids APPLY every Cloud Storage object permission, so live such an apply could not even lock the state. With `embedStateWrite: true`, the seal-time backend names STATE_WRITE. The EMULATED run shows every state access during seal, apply and cleanup was STATE_WRITE's, and APPLY and DISCOVERY never touched the bucket. As on AWS, the seal-time plan then reads STATE_WRITE's credential configuration file for the backend.

**Identities are engine-neutral.** Both engines use the same variables:
- `ALZ_<IDENTITY>_GOOGLE_APPLICATION_CREDENTIALS`
- `ALZ_<IDENTITY>_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT`
- `ALZ_<IDENTITY>_GOOGLE_PROJECT`
- `ALZ_<IDENTITY>_GOOGLE_REGION`

Each engine still gets its own service accounts, pool, custom roles and deny policy, so a GCP_API identity never holds a TERRAFORM grant. Path 6's engine never touches Terraform state, and its accounts have no access to the state bucket.

**Workload identity federation, never a key.**
- Each service account has one `roles/iam.workloadIdentityUser` binding, for the pool principal of exactly one subject (`principal://iam.googleapis.com/<pool>/subject/<subject>`).
- The provider's attribute condition admits only the engine's subjects.
- Optionally, `oidc_required_claims` ANDs exact claims into that condition. A subject is name-based, so for GitHub pin the numeric `repository_id` (and `repository_owner_id`): a deleted-and-recreated or transferred repository with the same name then mints no accepted token. Recommended for GitHub.
- No key is created, and the org policy forbids creating one.
- The package outputs one credential configuration per identity: an `external_account` file source with no key, no token and no `service_account_impersonation_url`. That is exactly the shape the G0 package requires and the S1 provider spec (`src/apply/providers/gcp.ts`, merged in #305) checks.

**State bucket (TERRAFORM).**
- Uniform bucket-level access and public access prevention are on, and versioning is on.
- One lifecycle rule deletes a noncurrent version only once at least `noncurrent_versions_kept` newer versions exist (default 10) and it has been noncurrent for `noncurrent_version_retention_days` (default 90).
- The bucket name must be dotless, matching the S1 provider spec (`src/apply/providers/gcp.ts`, #305).
- STATE's and STATE_WRITE's grants are on the bucket only, under IAM Conditions on the object name (UNVERIFIED, G-4).

**Deny guardrails** (`deny_pilot_guardrails`, default on).
- APPLY and DISCOVERY are denied every Cloud Storage object permission in the project. Neither can become a state fallback, whatever role it is later given.
- APPLY is denied changing any bucket's IAM policy or settings, or deleting a bucket (`storage.googleapis.com/buckets.setIamPolicy`, `.update`, `.delete`). Even if APPLY is later given a storage administration role, it cannot re-grant the state bucket, turn off its versioning or change its lifecycle. Deny conditions judge resource tags, not names, so this covers every bucket in the project.
- APPLY is also denied editing the pilot's service accounts, pool, custom roles and the project IAM policy. This is the GCP form of the AWS bucket policy's "deny everyone else" and of `DenyEditingBootstrapIdentity`.
- If a reviewed blueprint must write objects or manage a bucket, turn it off for that project and say so in the change record.

**No predefined role, for any identity** (owner decision D12, #39 6483366237). Every grant is a custom role that lists exactly the permissions in the table above. The only predefined role the package names is each service account's own `roles/iam.workloadIdentityUser` binding, which lets one subject impersonate it.
- `apply_additional_roles` must stay empty. Its old allowlist is gone: `roles/pubsub.publisher` and `roles/pubsub.subscriber` publish and consume messages, `roles/pubsub.viewer` reads more than topic metadata, and the logging and monitoring viewers are broad predefined roles. D12 forbids all of these.
- No Viewer, Editor or Owner role, no `roles/cloudasset.viewer`, and no Service Account Token Creator.
- A role could only come back through a reviewed change to this package and a new owner decision.

**DISCOVERY is deliberately narrower than the G0 table.**
- The G0 identity table gives DISCOVERY `roles/cloudasset.viewer`, `roles/browser` and `roles/storage.objectViewer` on the state bucket.
- This package grants only `pubsub.topics.get`, `cloudasset.assets.searchAllResources` and, on the state bucket alone, `storage.buckets.get`. The deny policy also forbids DISCOVERY every object.
- Why: the reader (S3, #310) needs exactly these permissions, and the readiness check reads the bucket's metadata, never an object. State is STATE's and STATE_WRITE's only, which matches `bootstrap/aws`, where the bucket policy also denies DISCOVERY.
- A wider read, if a later reader needs one, is a reviewed change.

**Owner items, off by default** (`docs/act-pilot-gcp-terraform-g0.md`, proposals):
- **P3** `lock_version_retention_days`: a rule that deletes noncurrent `*.tflock` versions after N days. It matches the suffix `.tflock` only, never `.tfstate`.
- **P5** `enable_storage_data_access_logs`: Cloud Storage `DATA_READ` and `DATA_WRITE` audit logs on the project. The qualifier's `SEPARATED` attestation needs them, and they are billed as log volume.

**Budget** (optional): `budget_monthly_usd` plus `billing_account_id` create a `google_billing_budget` on the project, with alerts at 80 and 100 percent.

## Prerequisites: what the project owner needs

- The DEV project only, for both engines.
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

In the DEV project, in its own workspace or directory copy:

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

If the TERRAFORM run in that project already manages the org policy, set `enforce_no_service_account_keys = false`, so the policy is not managed twice. The policy is then owned by the TERRAFORM run alone: destroying that run removes it, even while the GCP_API run remains. Tear down the GCP_API run first (see Teardown), or re-apply the GCP_API run with `enforce_no_service_account_keys = true` before destroying the TERRAFORM run.

The run creates `<prefix>-dev-api-discovery` and `<prefix>-dev-api-apply`, its own pool, roles and deny policy, and nothing else.

## Step 3: Runner setup

For each identity, write `terraform output -json credential_configurations` entry to a file on the runner:
- mode 0600, outside the working tree;
- one file per identity, never shared.

The runner's OIDC token for that identity must be written to the `token_files` path named in that file. Then set, per identity:
- `ALZ_<IDENTITY>_GOOGLE_APPLICATION_CREDENTIALS`: that file's absolute path;
- `ALZ_<IDENTITY>_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT`, `ALZ_<IDENTITY>_GOOGLE_PROJECT` and `ALZ_<IDENTITY>_GOOGLE_REGION`: from `terraform output -json identity_variables`.

Set no other `GOOGLE_*`, `GCLOUD_*`, `CLOUDSDK_*` or `GCE_*` variable, and never `STORAGE_EMULATOR_HOST`. The G0 package forbids them, and the S1 provider spec (`src/apply/providers/gcp.ts`, #305) refuses each of them by name. The spec runs for every GCP contract, which is admitted for DEV only.

## Step 4: Fill the configuration

`bootstrap/config.gcp.template.json` shows where each output goes:
- `contract_target` goes into the contract's `targets.DEV`;
- `contract_settings` goes into the contract itself: `"enabledEnvironments": ["DEV"]`, and for TERRAFORM `"embedStateWrite": true`;
- the service account emails and file paths go into the `ALZ_<IDENTITY>_*` variables.

Identifiers and paths only. Leave `enabled: false` and add no `authorize` entry.

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
2. In the DEV project, destroy the GCP_API run before the TERRAFORM run. The org policy belongs to whichever run manages it (Step 2), so the order keeps it in place while either run remains.
3. Run `terraform destroy` per project. For TERRAFORM, set `force_destroy_state = true` once, apply, then destroy.

Custom roles are soft-deleted for about 7 days, and a pool for about 30. Recreating one with the same id inside that window fails; undelete it or choose another `name_prefix`.

## Before bootstrap: the D12 checklist

Owner decision D12 (#39 6483366237) requires every supporting permission and token scope to be verified **before** bootstrap. Check them against Google's published IAM permissions reference, the custom-role supported-permissions list and the API discovery documents, with no live call. Lane G1 reviewed the package against the eight items on 2026-10-29. Status is one of:
- **VERIFIED IN CODE**: this package, or the product, does what the item says, and a test pins it.
- **SUPPORTED OFFLINE**: a pinned or recorded Google document agrees, but Google's acceptance is not proven.
- **UNVERIFIED, MUST CHECK**: the owner checks it against Google's reference before bootstrap.

| # | Item (`docs/act-pilot-gcp-api-driver.md`, D12) | Status |
| --- | --- | --- |
| 1 | `pubsub.topics.get` is the only permission `topics.get` needs, and it is supported in custom roles. | **UNVERIFIED, MUST CHECK.** Used by both paths' DISCOVERY and path 5's APPLY. |
| 2 | `pubsub.topics.create` alone permits `topics.create` with `labels` and `messageStoragePolicy` (GF4, GF9). | **UNVERIFIED, MUST CHECK.** The Pub/Sub v1 discovery document (revision 20261006) shows `create` is `PUT v1/{+name}` and that `Topic` carries `messageStoragePolicy`. It does not name permissions. |
| 3 | `pubsub.topics.delete` alone permits `topics.delete`. | **UNVERIFIED, MUST CHECK.** |
| 4 | `cloudasset.assets.searchAllResources` at project scope is the only permission `searchAllResources` needs, and it is supported in custom roles at project level (GF10). | **UNVERIFIED, MUST CHECK.** Path 5 needs it too, for the unit sweep. |
| 5 | No custom role holds `pubsub.topics.publish`, `.update`, `.setIamPolicy`, any `pubsub.subscriptions.*`, any `*.setIamPolicy`, any `serviceusage.*`, or `iam.serviceAccounts.getAccessToken` beyond the `roles/iam.workloadIdentityUser` binding. | **VERIFIED IN CODE** (`test/bootstrap-gcp.test.ts`, `terraform test`). `pubsub.topics.update` was removed from path 5's APPLY. Subject to GF7. |
| 6 | The APIs the path calls (`pubsub`, `sts`, `iamcredentials`, `cloudasset`) are enabled by the owner's bootstrap, and no runtime identity can enable a service. | **VERIFIED IN CODE.** `google_project_service.required`, and no identity holds `serviceusage.services.enable`. |
| 7 | The token scopes: what the STS exchange requests (GF8), `pubsub` for Pub/Sub `get`, `create` and `delete` (GF2), and the narrowest scope Cloud Asset accepts (GF3). | **PARTLY.** The reader now mints one token per host (D15, `src/observe/gcp-rest.ts`): `https://www.googleapis.com/auth/pubsub` for Pub/Sub, which the discovery document lists on `get`, `create` and `delete` (GF2, SUPPORTED OFFLINE), and `https://www.googleapis.com/auth/cloud-platform` for Cloud Asset (GF3, **UNVERIFIED, MUST CHECK** whether `cloud-platform.read-only` would do). The exchange asks for `cloud-platform`, as Google's own Go auth library does in the EMULATED run (GF8, **UNVERIFIED, MUST CHECK**). Read-only rests on IAM, never on a scope. |
| 8 | The contract-target output for GCP_API matches D9's shape. | **VERIFIED IN CODE** (`contract_target`, the template, and both test suites). |

The Google facts behind those items:

| Fact | Status |
| --- | --- |
| **GF7**: whether a call (most likely Cloud Asset `searchAllResources`) needs a quota project or `serviceusage.services.use` when the impersonated service account makes it. | **UNVERIFIED, MUST CHECK.** If it does, it conflicts with item 5, and the conflict goes back to the owner before bootstrap. It is never resolved by widening a grant. |
| **GF8**: the scope the STS exchange must request. | **UNVERIFIED, MUST CHECK.** EMULATED: the reader, the google provider and the gcs backend all send `cloud-platform` to `sts.googleapis.com/v1/token` (form-encoded). That shows what Google's own client sends, not what Google accepts. |
| **GF9**: `pubsub.topics.create` alone covers a create carrying `messageStoragePolicy`. | **UNVERIFIED, MUST CHECK.** |
| **GF10**: `cloudasset.assets.searchAllResources` is supported in custom roles at project level. | **UNVERIFIED, MUST CHECK.** |
| **GF11**: `roles/iam.workloadIdentityUser` carries `iam.serviceAccounts.getAccessToken` for federated principals, so no Token Creator role is needed. | **UNVERIFIED, MUST CHECK.** The package relies on it (no Token Creator anywhere). The EMULATED run emulates that binding; it cannot prove Google's behavior. |

**DISCOVERY sees more than the code asks for.** `searchAllResources` on the project returns the metadata (names, types, labels, locations and similar fields) of every indexed resource in the DEV project, not only Pub/Sub topics. The code filters on the unit label; IAM does not. That is why the grant is a custom role on the DEV project only.

## Assumptions not verified

- **Provider schema.** Checked offline only, against `hashicorp/google` 8.9.0 (the product's reviewed version). Other versions inside `>= 8.0, < 9.0` may differ.
- **G-1.** The `google` provider and the `gcs` backend honor an `external_account` file-source configuration through `GOOGLE_APPLICATION_CREDENTIALS`, with impersonation from `GOOGLE_IMPERSONATE_SERVICE_ACCOUNT` and the backend's `impersonate_service_account`.
- **`roles/iam.workloadIdentityUser`** is sufficient for a federated principal to impersonate the account through `generateAccessToken`, without `roles/iam.serviceAccountTokenCreator` (GF11).
- **G-4.** IAM Conditions on `resource.name` for Cloud Storage objects hold under uniform bucket-level access. A list call is judged against the bucket, which the conditions admit.
- **Deny policies.** The `storage.googleapis.com/objects.*`, `storage.googleapis.com/buckets.setIamPolicy`, `.update` and `.delete`, `iam.googleapis.com/...` and `cloudresourcemanager.googleapis.com/projects.setIamPolicy` permission names are supported in deny policies.
- **Permissions.** `pubsub.topics.create`, `.delete` and `.get` are enough for the Pub/Sub topic workload, and `cloudasset.assets.searchAllResources` for the unit sweep (D12 items 1 to 4).
- **Billing budget.** The budget API may require a quota project for the owner's login (`gcloud auth application-default set-quota-project`).
