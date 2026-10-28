# G0 package: GCP Terraform pilot, and the owner-input kit

Status: G0 is a documentation gate ("Docs only; no heavyweight run", `docs/act-pilot-plan.md`). This page is slice S0 of the GCP release-path PLAN. The owner approved that PLAN "as designed" on 2026-10-27, with decisions 1 to 5 (issue #39, comment 6433121154). The page records what the PLAN decided for G0: provider and engine, identities, state layout, unit labels, protected classes, approver roles, and rollback and partial-failure behavior. It then lists every input only the owner can supply. It follows the AWS package (`docs/act-pilot-aws-terraform-g0.md`) wherever the two paths are the same.

**This page follows the approved PLAN.** Where it adds to or departs from the PLAN, the text marks it **PROPOSAL**, and the section "Departures and open owner questions" lists each one with its reason. A PROPOSAL needs the owner's confirmation before S1 builds it. Facts about Google Cloud, the `gcs` backend and the `google` provider that the PLAN marked UNVERIFIED stay UNVERIFIED here, with the PLAN's question number (G-1 to G-7). The repository convention applies to each: a wrong validator refuses a good value, and never admits a bad one. G-7 is the one question the S0 spike answered, against an emulator (`docs/act-pilot-simulation-gcp.md`, SYNTHETIC).

**Implementation status.** GCP Terraform is admitted in code for DEV only (owner decision 6481421924 on issue #39): `ProviderId` names `GCP`, the provider spec (`src/apply/providers/gcp.ts`) is registered, the contract accepts a GCP target (`projectId`, `region`, `backend` as `<bucket>/<prefix>`, `workspace`, optional `parent`) only under `"enabledEnvironments": ["DEV"]`, the backend pin writes `backend "gcs" {}`, the runner's pilot apply profile hands a Terraform child the four Google identity variables only (with the metadata server switched off, G-2 below), the target's canary allowlist is one `google_pubsub_topic` (owner decision E1), `hashicorp/google` is pinned to the reviewed 8.9.0 with HashiCorp's own hashes, and observation and cleanup read through `src/observe/gcp-rest.ts` and `src/apply/cleanup-gcp.ts`. `test/apply-gcp-admission.test.ts` drives the whole journey against the fake engine and a scripted Google (SYNTHETIC). Still open: the `act:gcp-terraform` release path and its journey row (the next integrator step; it needs a GCP Phase E scenario, so GCP in `src/discovery`, PLAN S5), the driver-level emulated run (S6b) and every live gate.

Nothing on this page enables ACT. The repository ships no pilot contract (the old `config/act-pilot-contract.sha256` pin is removed; the contract's `authorize` entry is the switch), and the product's ACT default stays DISABLED. A GCP contract is admitted for DEV only, and only the owner's reviewed contract with an `authorize` entry enables ACT for it. Agents never hold approver keys and never initiate an apply (`AGENTS.md`, the ACT amendment). Owner decision 5 sets the order: GCP goes live after AWS Terraform and Azure.

People are never named here. Where a person is needed, the text uses a role and the placeholder `<name>`.

## G0 decisions

### Provider and engine

| Decision | Value | Source |
| --- | --- | --- |
| Provider | `GCP`, through the `hashicorp/google` Terraform provider | owner decision 1; PLAN section 1 |
| Engine | `TERRAFORM` with the `gcs` state backend. Infrastructure Manager stays the candidate for the `GCP/NATIVE_API` row (`src/release/acceptance.ts`) and is not implemented | owner decision 1 |
| `google-beta` | refused for the pilot. Only `hashicorp/google` and the cloud-free set (`random`, `null`, `time`, `tls`, the built-in `terraform`) are allowed providers | owner decision 4; PLAN section 2, "Provider-config rules" |
| Layout | one GCP project per environment (DEV, QA, PROD), each with its own state bucket in that project | owner decision 2 |
| Contract scope | the **three-stage contract**: no `enabledEnvironments` field, with targets and approvals for DEV, QA and PROD | PLAN section 2. See "Contract scope" below |
| Identities | four Workload Identity Federation (WIF) principals, each impersonating its own service account: DISCOVERY, STATE, STATE_WRITE and APPLY. No key files | owner decision 3; PLAN section 2 |
| APPLY authority | a named role set per project. `roles/owner` is refused by the bootstrap, and `roles/editor` is discouraged | owner decision 5; PLAN Q4 |
| CMEK | off for DEV: the DEV state bucket uses Google-managed encryption. QA and PROD are the owner's call | owner decision 5; PLAN Q8 |
| Channel | the terminal or the console wizard, chosen when the workflow starts and sealed into the plan, never mixed | `docs/act-pilot-apply.md`, "Channels" |

### Contract scope: GCP is not under the DEV-only pilot exception

The DEV-only scope (`"enabledEnvironments": ["DEV"]`) is an owner exception for **AWS Terraform only** (ACT-DEV-1, `docs/act-dev-1.md`). The validator enforces this: `src/apply/contract.ts` refuses the field for any other provider and engine ("DEV-only scope is approved only for AWS Terraform ACT-DEV-1"). The PLAN keeps it that way (section 2: "the DEV-only exception stays AWS Terraform only").

A GCP contract is therefore a three-stage contract. It carries `targets` and `requiredApprovals` for DEV, QA and PROD, with three distinct projects and buckets. Each stage keeps its own gates:

- the first apply is in DEV;
- QA promotes a release that succeeded in DEV;
- PROD promotes a release that succeeded in QA, with two production approvers.

Putting GCP under a DEV-only scope would extend an owner exception. That is an authority change, and it needs its own owner decision before any GCP contract may carry `enabledEnvironments`. S0 does not decide it. It is listed below as open owner question O1.

### Identities: WIF with service-account impersonation

Each environment's project holds four service accounts, one per pilot identity, so the principals differ per environment (`principalPerEnvironment`, as on AWS). The execution host holds, per identity:

- a short-lived OIDC token file;
- a WIF credential configuration that names that token file.

The federated principal holds no role of its own. It only impersonates the identity's own service account, and the service account's email is the attested principal: it is what `./alz apply qualify` attests and what audit logs show.

| Identity | Service account (the PLAN's naming) | What it may do (PLAN section 3) |
| --- | --- | --- |
| DISCOVERY | `alz-pilot-<env>-discovery@<project>.iam.gserviceaccount.com` | `roles/cloudasset.viewer` and `roles/browser` on the project; `roles/storage.objectViewer` on the state bucket; the read-only viewer roles the blueprint needs |
| STATE | `alz-pilot-<env>-state@...` | a custom role on the bucket: get and list objects, plus create and delete under an IAM condition limited to names ending in `.tflock` (UNVERIFIED, G-4) |
| STATE_WRITE | `alz-pilot-<env>-state-write@...` | `roles/storage.objectUser` on the state bucket only. Used only by apply |
| APPLY | `alz-pilot-<env>-apply@...` | the owner's named roles on the project; `roles/owner` refused. No state-bucket access unless the blueprint itself writes there |

**Alignment with the owner's read-only discovery decision (not a PROPOSAL).** On 2026-10-27 the owner decided that every provider's read-only identity defaults to control-plane metadata and excludes application data and secret contents; any exception needs an explicit scope and purpose (issue #39, comment 6440801434, item 2). For GCP this means: DISCOVERY's viewer roles are metadata viewers (`roles/cloudasset.viewer`, `roles/browser` and service `*.viewer` roles that list and get configuration), not data readers such as `roles/secretmanager.secretAccessor`, `roles/bigquery.dataViewer` or `roles/storage.objectViewer` on application buckets. The row above also gives DISCOVERY `roles/storage.objectViewer` on the state bucket, and Terraform state can hold secret values; under the decision that grant is an exception that needs its own written scope and purpose, or the read moves to STATE as on AWS, where the bucket policy denies DISCOVERY the state bucket. This note records the alignment only. It changes nothing in P1 to P5 or O1, which stay with the owner, and S1 stays held.

The rules carry over from the plan's authority item 4:

- none inherits operator credentials, and none falls back to another;
- APPLY is never a state fallback;
- an identity the engine does not use is refused when configured.

**Identity variables (PLAN section 2).** They follow the runner's `ALZ_<IDENTITY>_<VAR>` injection rule: the suffix is the real variable the engine's child process receives, as `AWS_ROLE_ARN` is on AWS (`src/apply/providers/aws.ts`).

| Variable | Value | Check |
| --- | --- | --- |
| `ALZ_<IDENTITY>_GOOGLE_APPLICATION_CREDENTIALS` | absolute path of the identity's WIF credential configuration (`"type": "external_account"`, `credential_source.file` = the OIDC token file, audience = the pool provider). It holds no secret | UNVERIFIED (G-1): that the `google` provider and the `gcs` backend both honor an external-account configuration through this variable |
| `ALZ_<IDENTITY>_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT` | the identity's service account email | the spec's `clientIdVariable`: the attested principal, lowercase. The email's project segment must equal the contract's `projectId` |
| `ALZ_<IDENTITY>_GOOGLE_PROJECT` | the project id | must equal `targets.<ENV>.projectId` |
| `ALZ_<IDENTITY>_GOOGLE_REGION` | the region | must equal `targets.<ENV>.region` |

APPLY and STATE_WRITE must set all four.

**Where impersonation is configured (PLAN section 2).**

- **Provider:** through `GOOGLE_IMPERSONATE_SERVICE_ACCOUNT` in the APPLY or DISCOVERY child's environment. A `google` provider block must not set `credentials`, `access_token`, `impersonate_service_account`, `impersonate_service_account_delegates` or `scopes`, as a constant or an expression.
- **State backend:** through the partial backend configuration the driver gives `init` for STATE_WRITE (`backendConfig`):
  - `bucket` and `prefix`;
  - `credentials` = STATE_WRITE's credential-configuration path;
  - `impersonate_service_account` = STATE_WRITE's email.

  Every value is pattern-checked before it is written. `filledAtApply` is `credentials` and `impersonate_service_account`.

The credential configuration itself does not name a service account in the PLAN's design. **PROPOSAL** P1: S1's credential-configuration check also refuses a configuration that carries `service_account_impersonation_url`. Otherwise one file could impersonate an account other than the variable names.

**Refusals before any engine runs.** The PLAN's `ambientRefusal`, with one addition:

- **The credential-configuration check.** Each configuration is read once (at most 64 KiB, UTF-8 JSON) and refused (`IDENTITY_NOT_CONFIGURED`) unless:
  - `type` is `external_account`;
  - `credential_source.file` is an absolute token-file path;
  - none of `private_key`, `private_key_id`, `client_secret`, `refresh_token` or `token` is present.

  This is what keeps a service-account key file out: `GOOGLE_APPLICATION_CREDENTIALS` is also how a key file is supplied. Contents are never logged or copied.
- **Fallback variables** (`FALLBACK_VARIABLE`): `GOOGLE_CREDENTIALS`, `GOOGLE_CLOUD_KEYFILE_JSON`, `GCLOUD_KEYFILE_JSON`, `GOOGLE_OAUTH_ACCESS_TOKEN`, `GOOGLE_BACKEND_CREDENTIALS`, `GOOGLE_ENCRYPTION_KEY`, `CLOUDSDK_*`, `GCE_METADATA_HOST` and `GOOGLE_API_USE_CLIENT_CERTIFICATE`, plus `AWS_*`, `ARM_*` and `AZURE_*`. Any other variable matching `^(GOOGLE|GCLOUD|CLOUDSDK)_` is ambient and refused.
- **`STORAGE_EMULATOR_HOST`, named explicitly.** It does not match the ambient prefix. The S0 spike showed it redirects a sealed plan's state to another server with no credential at all (`docs/act-pilot-simulation-gcp.md`, findings B and F). It is refused in every identity's environment, and the runner drops it from every child outside the S6 test harness. **PROPOSAL** P2 (an addition to the PLAN that only refuses more).
- **Identity collapse.** Two identities that share a credential configuration, a token file or a service account are refused. `PRINCIPAL_NAME` in `src/tools/identity.ts` gains `IMPERSONATE_SERVICE_ACCOUNT$`, so the collapse check compares emails.
- **Metadata server.** The runner switches off the metadata server for every pilot Terraform child: `GCE_METADATA_HOST` and `GCE_METADATA_IP` are `metadata.invalid` (RFC 6761 reserves `.invalid` so it never resolves) and `NO_GCE_CHECK` is `True`. G-2, partly answered (SYNTHETIC, 2026-10-28, the signature-verified hashicorp/google 8.9.0 under Terraform 1.16.4, no Google credential): the Go auth library honors `GCE_METADATA_HOST` (with no credential configuration it asked `http://metadata.invalid/...` for a token and failed with "no such host"), and with a credential configuration set it never asked the metadata host. It has no documented switch that disables the metadata server. A live run confirms it on the execution host.

The bootstrap enforces `iam.disableServiceAccountKeyCreation` on every pilot project (owner decision 3; PLAN Q5). A key file therefore cannot be created for these accounts unless someone changes that policy outside the pilot.

An access token is never part of the backend configuration. The spike shows Terraform writes `-backend-config=access_token=...` in plaintext to `.terraform/terraform.tfstate` **and** embeds it in the saved plan (finding G1). The PLAN's `backendConfig` never builds one, and the backend-block rule refuses one in the project's block.

**State-write separation stays UNVERIFIED.** The spike confirms the Azure finding for the `gcs` backend: `terraform apply <planfile>` uses the backend settings embedded in the plan, and takes unset ones from the apply process's environment (finding F). It also shows that the plan embeds `impersonate_service_account` (an email, not a secret; finding G3). The emulator skips authentication, so whether a real apply writes state as STATE_WRITE, and never as APPLY, is answered only at G2. There, the qualifier attests `SEPARATED <STATE_WRITE email> <APPLY email>` from the audit log, or does not attest.

### State: one bucket per environment

| Item | Value |
| --- | --- |
| Bucket | one per environment, in that environment's project, created by the bootstrap; never managed by the pilot's Terraform |
| Bucket settings (bootstrap) | uniform bucket-level access on, versioning on, public access prevention enforced, a lifecycle rule keeping N noncurrent versions, CMEK optional (off for DEV) |
| Readiness | DISCOVERY reads `storage.buckets.get` and confirms versioning and uniform access are on |
| Contract `target` | `projectId` (`^[a-z][a-z0-9-]{4,28}[a-z0-9]$`); `region`; `backend` = `<bucket>/<prefix>`; `workspace`; optional `parent` (`organizations/<n>` or `folders/<n>`), which carries no authority |
| State and lock objects | `<prefix>/<workspace>.tfstate`, and the lock object `<prefix>/<workspace>.tflock`, created with a generation precondition. The PLAN marked the lock name UNVERIFIED (G-3); the spike observed it against the emulator only (SYNTHETIC) |
| Saved-backend check | `type` is `gcs`, and `bucket`/`prefix` equals the contract's |
| Backend-block rule | the project's block is `backend "gcs"` with `bucket` and `prefix` only. `credentials`, `access_token`, `impersonate_service_account*`, `encryption_key`, `kms_encryption_key` and `storage_custom_endpoint` are refused (`BACKEND_BLOCK_NOT_IN_CONTRACT`), as are a `cloud` block and another backend type |

`-lock=false` and `force-unlock` stay outside the pilot.

With versioning on, the lock object also leaves noncurrent versions: the spike saw three after two applies. **PROPOSAL** P3: the bootstrap's noncurrent-version lifecycle rule also removes noncurrent `*.tflock` versions after a few days. It must never match `*.tfstate`.

### Unit labels (PLAN section 4)

GCP calls resource tags **labels**. The product's one tag scheme (`src/teardown/unit.ts`) maps to labels unchanged:

| Product key | GCP label key | Value |
| --- | --- | --- |
| `alz-managed-by` | `alz-managed-by` | `alz` |
| `alz-unit` | `alz-unit` | `alzu-` plus 20 hex characters |
| `alz-build` | `alz-build` | `alz-pilot-<env>-<12 hex>` |

- **Label rules (UNVERIFIED, G-5).** Keys and values are at most 63 characters of lowercase letters, digits, `_` and `-`, and a key starts with a lowercase letter. The scheme's values already satisfy this: the product restricts them to `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`.
- **Where they come from.** The operator's provider block declares them through `default_labels`, which the PLAN requires to be set. `default_labels` exists in `google` provider 5.x and later (UNVERIFIED, G-6).
- **What the seal reads.** `tagAttributes` for GCP is `["effective_labels", "labels"]`. The plan carries `effective_labels` for every labelable `google_*` resource, provider defaults included. `terraform_labels` is not read.
- **Codes.** The seal reuses the existing codes: `UNIT_TAG_MISSING`, `UNIT_TAG_FOREIGN` and `UNIT_TAG_UNVERIFIABLE` (`src/apply/engines/terraform.ts`). There is no GCP-only code.
- **Unlabelable types.** A resource type with neither attribute is untaggable, and the sealed artifact lists it for the approvers, as today.
- A label stays a pointer, never ownership evidence.

### Protected classes (PLAN section 4, cleanup classifier)

A pilot cleanup never deletes these, directly or as a dependent. The rules apply in this order, through the one classifier, `protectionOf`, which the proposal and `protectedDeletionIn` share.

| Rule | Class | GCP objects |
| --- | --- | --- |
| 1 | `PROTECTED_BACKEND` | any environment's state bucket, in every identifier form: the bare name `<bucket>`, `b/<bucket>`, and `projects/_/buckets/<bucket>`. Covers `google_storage_bucket*`, `google_storage_bucket_iam_*`, `_object`, `_acl` and `_object_acl` naming that bucket. **PROPOSAL** P4 adds the forms `gs://<bucket>` and `//storage.googleapis.com/projects/_/buckets/<bucket>` |
| 2 | `PROTECTED_IDENTITY` | by anchored prefix, with no hand list: `google_service_account` (accounts, keys, `_iam_*`, `_access_token`, `_id_token`, `_jwt`); the whole `google_iam_` namespace (workload and workforce identity pools and providers, custom roles, deny policies, access boundary policies, principal access boundaries); `google_project_iam_`, `google_folder_iam_`, `google_organization_iam_`, `google_billing_account_iam_`, `google_tags_tag_key_iam_`, `google_tags_tag_value_iam_`; and every resource-level binding ending in `_iam_policy`, `_iam_binding`, `_iam_member` or `_iam_audit_config` (including `google_kms_crypto_key_iam_*`). Also `google_cloud_identity_` (groups and memberships) and `google_access_context_manager_` access levels and perimeter memberships |
| 2, by id | `UNCLASSIFIABLE` | a recorded id containing `/serviceAccounts/`, `/workloadIdentityPools/` or `/roles/` under a non-identity type (the AWS "ARN under another type" rule). The wrapper scan (`terraform_data`, `null_resource` and the container families) looks for `serviceAccount:<email>` members and `@<project>.iam.gserviceaccount.com` in attributes |
| 3 | `CONTAINS_OTHERS`, kept by the pilot owner | `google_project`, `google_folder` and `google_organization*` (a project is never deleted by a pilot cleanup, as a resource group never is); `google_project_service` and `google_project_service_identity` (project-wide API enablement); `google_deployment_manager_deployment` and the whole `google_infra_manager_` namespace; `google_access_context_manager_service_perimeter*`; and, by id, `projects/<n>`, `folders/<n>` and `organizations/<n>` as the whole id |
| 4 | ordinary (deletable when run-owned) | organization policies: `google_org_policy_policy`, `google_organization_policy`, `google_folder_organization_policy` and `google_project_organization_policy` (parity with the SCP decision 6431744115). Resource policies that are not IAM are ordinary too. The bootstrap's own `iam.disableServiceAccountKeyCreation` policy is not in the pilot's state and is never proposed |

- **Material risks.** `MATERIAL_RISKS` gains `google_storage_bucket`, `google_sql_database_instance`, `google_kms_crypto_key`, `google_secret_manager_secret`, `google_bigquery_dataset`, `google_compute_disk` and `google_logging_project_bucket_config`.
- **Unknown types.** A type the classifier does not know is never assumed to be ordinary. S4 ships the type list with a test per class.

### Approver roles

Unchanged from AWS (`docs/act-pilot-aws-terraform-g0.md`, "Approver roles"). Approvals are Ed25519 signatures by keys on the contract's allowlist, never a typed name. Because a GCP contract is three-stage, all of these roles are needed from the start:

- pilot owner;
- operator;
- DEV approver;
- QA approver;
- production approvers 1 and 2, on separate machines;
- qualifier;
- cleanup owner.

Two GCP differences:

- **The qualifier attests from Cloud Audit Logs, not CloudTrail.** **PROPOSAL** P5: the bootstrap enables Data Access audit logs for Cloud Storage on each pilot project. The attestation needs the state reads and writes logged, and these logs may be off by default (UNVERIFIED).
- **The operator holds four credential configurations and token files** rather than role ARNs.

The requester-is-not-an-approver rule is the plan's authority item 3. #286 is amending it, and it is out of this page's scope.

### Rollback and partial-failure behavior

The same driver, outcomes and ledger as AWS (`docs/act-pilot-aws-terraform-g0.md`, "Rollback and partial-failure behavior"; `src/apply/driver.ts`). There is no automatic rollback. The outcomes are `SUCCEEDED`, `FAILED_NO_CHANGE`, `PLAN_STALE`, `PARTIAL_REQUIRES_REVIEW` and `KILLED`, and a retry is always a new preview with new approvals.

The spike checked, against the emulator only, the engine text that `classifyApply` matches for the `gcs` backend:

- **Stale plan:** first line `Error: Saved plan is stale`.
- **Held lock:** first line `Error: Error acquiring the state lock`, with `googleapi: Error 412: Precondition failed`.

What the review must know (all SYNTHETIC):

- **SIGKILL leaves the lock object in place.** The next run is refused until a person reviews it and removes the lock by hand.
- **A graceful stop (SIGINT) releases the lock** and records what had run (the serial moves).
- **Unreachable Google endpoints make the backend retry without a bound.** SIGTERM did not end such a run within four minutes. The driver's 30-minute limit and its SIGKILL of the process group are what end it.

## Requirements from the spike: owning slice and test

Each security requirement the spike produced, with the PLAN slice that builds it and the test that pins it. Test files are the PLAN's names.

| Requirement | Slice | Test |
| --- | --- | --- |
| `STORAGE_EMULATOR_HOST` refused in every identity's environment, and dropped by the runner profile (P2) | S1 | `test/apply-gcp.test.ts` (identities and ambient refusal); the profile case alongside the existing runner-profile tests |
| `storage_custom_endpoint` and `access_token` refused in the project's backend block | S1 | `test/apply-gcp.test.ts` (backend block) |
| The driver-built `-backend-config` carries only `bucket`, `prefix`, `credentials` (a path) and `impersonate_service_account` (an email), never `access_token` or an endpoint | S1 | `test/apply-gcp.test.ts` (backend config, saved backend) |
| A key-file credential (`"type": "service_account"`, or any `private_key`) is refused, and so is a configuration with its own impersonation URL (P1) | S1 | `test/apply-gcp.test.ts` (the credential-configuration file check) |
| `STORAGE_EMULATOR_HOST` allowed only inside the opt-in harness, on the terms of owner decision 6432984515 on issue #39 (the Azurite precedent) | S6 | `test/apply-emulated-gcp.test.ts` (opt-in through `ALZ_SIM_TERRAFORM` and `ALZ_SIM_FAKE_GCS`) |
| Lock, stale plan, kill switch and SIGINT behavior through the driver against the real binary | S6 | `test/apply-emulated-gcp.test.ts` |
| Protected classes, including `b/<bucket>`, the `google_iam_` namespace, `google_project_service_identity` and `/serviceAccounts/` ids under another type | S4 | `test/apply-cleanup-gcp.test.ts` |
| Review of #305, N1: a FIFO, device or directory in place of a credential configuration or token file is refused at once, never waited on (`stat` before a non-blocking open) | admission prerequisites | `test/apply-gcp.test.ts` (review N1) |
| Review of #305, N2: the saved `gcs` backend is an allowlist (`bucket`, `prefix`, `credentials`, `impersonate_service_account`; anything else must be null), and the saved `credentials` and `impersonate_service_account` are exactly STATE_WRITE's own `GOOGLE_APPLICATION_CREDENTIALS` and `GOOGLE_IMPERSONATE_SERVICE_ACCOUNT` | admission prerequisites | `test/apply-gcp.test.ts` (review N2) |
| Review of #305, N3: data sources that mint a token or read a secret (`google_client_config`, `google_service_account_access_token`, `_id_token`, `_jwt`, Secret Manager secret versions and their access forms, `google_kms_secret`, `google_kms_secret_asymmetric`) are refused (`PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT`) | admission prerequisites | `test/apply-gcp.test.ts` (review N3) |
| Review of #305, N4: a resource or data source whose provider the plan does not name is refused (`PROVIDER_CONFIG_NOT_IN_CONTRACT`) | admission prerequisites | `test/apply-gcp.test.ts` (review N4) |
| Review of #310, N5: the cleanup classifier calls the GCP branch for a GCP contract, and any provider with no branch of its own is unclassifiable, never an ordinary leaf | admission prerequisites | `test/apply-cleanup-provider.test.ts` |

## Departures and open owner questions

Each departure below needs the owner's confirmation before S1 starts. None of them widens authority: P1 to P4 only refuse or protect more, and P5 adds evidence.

| Id | What | Reason |
| --- | --- | --- |
| P1 | refuse a credential configuration that carries `service_account_impersonation_url` | the PLAN configures impersonation through the provider and backend settings; a second impersonation path in the file could point at another account |
| P2 | refuse `STORAGE_EMULATOR_HOST` by name in every identity and child environment | the PLAN's ambient prefix does not match it, and the spike shows it redirects state with no credential |
| P3 | the bucket lifecycle rule also removes noncurrent `*.tflock` versions | versioning keeps every lock object version (spike finding C) |
| P4 | protect the `gs://<bucket>` and `//storage.googleapis.com/projects/_/buckets/<bucket>` forms in addition to the PLAN's | more identifier forms the bucket can appear under |
| P5 | the bootstrap enables Cloud Storage Data Access audit logs | the qualifier's `SEPARATED` attestation needs state access to be logged (UNVERIFIED whether it is by default) |
| O1 | **open owner question:** may a GCP contract use a DEV-only scope? | today the exception is AWS Terraform only; S0 assumes the three-stage contract and decides nothing here |

## Gap assessment, G0 to G5

Evidence from a fake engine or an emulator is synthetic and never counts as live (`AGENTS.md`).

| Gate | Exists | Engineering gap (PLAN slice) | Owner item |
| --- | --- | --- | --- |
| G0 | this page; the PLAN and its approval (6433121154); the G-7 spike | none after this page merges and the owner answers P1 to P5 and O1 | assign the roles; choose the execution host; name the change, the APPLY role sets and the cleanup owner |
| G1 | none for GCP | S1 (spec, identities, backend, provider config); S3 (reader); S4 (classifier), each with its denial-path tests | none |
| G1b | the G-7 answer: the `gcs` backend honors `STORAGE_EMULATOR_HOST` against fake-gcs-server | S6: the opt-in emulated test through the driver | none for the simulation |
| G2 | none | S2 (bootstrap); `qualify` and `preflight` once S1 lands | three projects, the bootstrap, the credential configurations and token files, a qualifier, one supervised DEV apply recorded with `record-live` |
| G3 | release admission reads the same pin | S5: `act:gcp-terraform` in `scope.json` and `status.json`, `gcp-provider` gate | the owner's authorization commit |
| G4 | the promotion chain, provider-independent | none beyond S1 to S7 | the QA and PROD projects, buckets, identities and both production approvers |
| G5 | `./alz apply record-recovery`, provider-independent | none beyond S1 | demonstrate a recovery on the real project |

## Every owner-supplied item, mapped

Identifiers and paths only. No token, key or secret value is ever written into the contract or shown to this product.

| Owner item | Contract field or check | Notes |
| --- | --- | --- |
| The reviewed `policyVersion` | `policyVersion` | as on AWS |
| Three project ids (DEV, QA, PROD), and whether DEV pre-exists | `targets.<ENV>.projectId` | pairwise distinct |
| Optional organization or folder | `targets.<ENV>.parent` | carries no authority; one readiness check |
| The region | `targets.<ENV>.region` | `ALZ_<IDENTITY>_GOOGLE_REGION` must equal it |
| The state bucket per project, and the prefix | `targets.<ENV>.backend` as `<bucket>/<prefix>` | created by the bootstrap |
| The workspace | `targets.<ENV>.workspace` | `default` unless the owner decides otherwise |
| Approvals, approval lifetime, approvers, kill switch path | `requiredApprovals` (DEV and QA at least 1, PROD at least 2), `maxApprovalAgeMinutes`, `approvers[]`, `killSwitchPath` | as on AWS |
| OIDC issuer, audience, and the four subjects per environment | not a field | bootstrap: the pool provider's attribute condition and one `roles/iam.workloadIdentityUser` binding per account |
| The service-account emails | `ALZ_<IDENTITY>_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT` | the attested principals |
| The credential-configuration and token-file paths on the execution host | `ALZ_<IDENTITY>_GOOGLE_APPLICATION_CREDENTIALS` | `external_account` only; four distinct files per environment |
| The APPLY role list and the DISCOVERY viewer roles per project | the bootstrap | `roles/owner` refused |
| Billing account and budget thresholds | the bootstrap | `google_billing_budget` per project |
| CMEK for the QA and PROD buckets | the bootstrap | off for DEV |
| The labels | the project's `default_labels` | the three `alz-*` labels that `prepare` prints |
| The execution host, the change, the cleanup owner | this page | as on AWS |
| Answers to P1 to P5 and O1 | this page | before S1 |

## The owner's checklist (after S1 to S7 land)

Each step is the owner's, or done by a person the owner names. No agent performs any of them.

1. Answer P1 to P5 and O1. Assign the roles, choose the execution host, and write down the change, the APPLY role sets and the cleanup owner.
2. Create or verify the three projects, with budgets.
3. Run the GCP bootstrap per project with a separately held administrative identity. Place the credential configurations and token files on the execution host.
4. Fill a copy of the GCP example contract with `enabled: false`, and run `./alz apply contract-check` until it reports COMPLETE.
5. Set the identity variables and run `./alz apply preflight --environment DEV`.
6. Wait for G1b (S6) to pass.
7. Review, set `enabled: true`, add the `authorize` entry, and commit the contract in one reviewed change. This step enables the pilot, and it is the owner's alone.
8. Have the qualifier run `./alz apply qualify` and attest from Cloud Audit Logs.
9. Supervise the DEV apply in one channel, and record it with `./alz apply record-live`. Then promote to QA and PROD under their own seals and approvals.
10. Separately authorize the live cleanup.
