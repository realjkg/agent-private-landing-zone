# G0 package: GCP Terraform pilot, and the owner-input kit

Status: G0 is a documentation gate ("Docs only; no heavyweight run", `docs/act-pilot-plan.md`). This page is slice S0 of the GCP release-path PLAN the owner approved on 2026-10-27 (issue #39, comment 6433121154). It records the provider and engine, the identities, the state layout, the approver roles and the rollback and partial-failure behavior the GCP path will inherit from the driver. It then lists every input only the owner can supply. It follows the AWS package (`docs/act-pilot-aws-terraform-g0.md`) wherever the two paths are the same, and says where GCP differs.

**Nothing on this page is implemented yet.** The product has no GCP provider spec: `ProviderId` in `src/apply/types.ts` is `AZURE` or `AWS`, and a contract with `"provider": "GCP"` is not a contract. The variable names, contract fields and checks below are the design the later slices (S1 to S7, in the PLAN's order) build and test. Where this page says "the driver refuses", read "the driver will refuse, once the GCP spec exists". Until then the GCP release path has no seal, no apply and no cleanup.

Nothing on this page enables ACT. The shipped pin (`config/act-pilot-contract.sha256`) stays empty, and the product's ACT default stays DISABLED. Agents never hold approver keys and never initiate an apply (`AGENTS.md`, the ACT amendment). The owner set the order: GCP goes live after AWS Terraform and Azure (decision 5).

People are never named here. Where a person is needed, the text uses a role and the placeholder `<name>`.

## G0 decisions

### Provider and engine

| Decision | Value | Source |
| --- | --- | --- |
| Provider | `GCP`, through the `hashicorp/google` Terraform provider | owner decision 1 |
| Engine | `TERRAFORM` with the `gcs` state backend. Infrastructure Manager stays the candidate for the `GCP/NATIVE_API` row (`src/release/acceptance.ts`) and is not implemented | owner decision 1 |
| `google-beta` | refused for the pilot. A project whose configuration or lock file names `hashicorp/google-beta`, or any resource with `provider = google-beta`, is refused at seal | owner decision 4 |
| Layout | one GCP project per environment (DEV, QA, PROD), each with its own state bucket | owner decision 2 |
| Pilot scope | the DEV-only pilot (`"enabledEnvironments": ["DEV"]`), one additive change in the DEV project | same as AWS (`docs/act-dev-1.md`) |
| Identities | four Workload Identity Federation (WIF) principals, each impersonating its own service account: DISCOVERY, STATE, STATE_WRITE, APPLY. No key files | owner decision 3 |
| CMEK | off for DEV: the DEV state bucket uses Google-managed encryption | owner decision 5 |
| Channel | the terminal or the console wizard, chosen when the workflow starts and sealed into the plan, never mixed | `docs/act-pilot-apply.md`, "Channels" |

### Identities: WIF with service-account impersonation

Each pilot identity is a separate service account in the environment's project. The execution host holds a short-lived OIDC token file for each identity. Google's Security Token Service exchanges that token through the project's workload identity pool, and the federated principal then impersonates its own service account. The service account's email is the attested principal: it is what Cloud Audit Logs show and what `./alz apply qualify` attests.

| Identity | Service account (example name; the owner chooses) | What it may do |
| --- | --- | --- |
| DISCOVERY | `alz-discovery@<project>.iam.gserviceaccount.com` | read-only provider reads and the cleanup observation (Cloud Asset Inventory, resource reads) |
| STATE | `alz-state@...` | read the state object, and create and delete the lock object only |
| STATE_WRITE | `alz-state-write@...` | read and write the state object, and create and delete the lock object. Used only by apply |
| APPLY | `alz-apply@...` | provider writes, through a named role set on the DEV project. `roles/owner` is refused (decision 5). No access to the state bucket |

The rules carry over from the plan's authority item 4. None inherits operator credentials, and none falls back to another. APPLY is never a state fallback, and an identity the engine does not use is refused when configured.

**Credential material: token files and credential configurations, never key files.**

- Per identity, the execution host holds two non-secret files plus the token:
  - a WIF credential configuration (`"type": "external_account"`), whose `credential_source.file` names the identity's token file and whose `service_account_impersonation_url` names the identity's own service account;
  - the OIDC token file itself (short-lived).
- Proposed variables, fixed by the provider-spec slice:
  - `ALZ_<IDENTITY>_GCP_CREDENTIAL_CONFIG_FILE`: absolute path to the configuration;
  - `ALZ_<IDENTITY>_GCP_SERVICE_ACCOUNT`: the email the configuration must impersonate;
  - `ALZ_<IDENTITY>_GCP_PROJECT`: must equal the contract's project.
- `preflight` refuses, before any engine runs:
  - a configuration of `"type": "service_account"`, or any file that holds a `private_key`;
  - a configuration whose impersonation target is not the named service account;
  - two identities that share a configuration, a token file or a service account;
  - the operator's own `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CREDENTIALS`, `GOOGLE_OAUTH_ACCESS_TOKEN`, `CLOUDSDK_*` login or Application Default Credentials leaking into an identity's environment.
- The bootstrap enforces `iam.disableServiceAccountKeyCreation` on every pilot project (decision 3). A key file therefore cannot exist for these accounts unless someone changes that policy outside the pilot, and `preflight` reports the policy's state as an item.
- An access token is never passed as `-backend-config=access_token=...`. The G-7 spike shows that Terraform writes that value in plaintext to `.terraform/terraform.tfstate` **and** embeds it in the saved plan (`docs/act-pilot-simulation-gcp.md`, finding G1). The backend and provider authenticate from the credential configuration in the process environment.

**State-write separation (open, carried from AWS and Azure).** The spike confirms, for the `gcs` backend, the Azure finding: `terraform apply <planfile>` uses the backend settings embedded in the plan, and fills unset ones from the apply process's environment. The `gcs` backend has its own `impersonate_service_account` attribute, separate from the provider's, and the spike shows the plan embeds it (an email, not a secret).
- The GCP analog of the contract's opt-in `embedStateWrite` is to embed STATE_WRITE's service account there at seal.
- Whether a real apply then writes state as STATE_WRITE, and never as APPLY, is **UNVERIFIED**. The emulator does not exercise authentication. G2 answers it from Cloud Audit Logs, and the qualifier attests `SEPARATED <STATE_WRITE SA> <APPLY SA>` only when the audit log shows it.

### State: one bucket per environment

| Item | Value |
| --- | --- |
| Bucket | one per environment, in that environment's project, created by the bootstrap. Not created or managed by the pilot's Terraform |
| Versioning | on. A noncurrent version is the recovery copy of an overwritten state |
| Access | uniform bucket-level access on; public access prevention enforced; no ACLs |
| Encryption | Google-managed for DEV (decision 5); CMEK for QA and PROD is a later owner decision |
| Contract `backend` | `<bucket>/<prefix>`. The state object is `<prefix>/<workspace>.tfstate` |
| Locking | the backend's own lock object, `<prefix>/<workspace>.tflock`, created with a generation precondition (`ifGenerationMatch=0`). There is no separate lock table. Observed in the spike against the emulator; `-lock=false` and `force-unlock` stay outside the pilot |
| Allowed backend block | `backend "gcs" {}` with at most `bucket` and `prefix`. `credentials`, `access_token`, `impersonate_service_account*`, `encryption_key`, `kms_encryption_key` and `storage_custom_endpoint` are refused in the project's block. A `cloud` block or another backend type is refused, as on AWS (`BACKEND_BLOCK_NOT_IN_CONTRACT`) |
| Emulator settings | `STORAGE_EMULATOR_HOST` and `storage_custom_endpoint` are refused in every product path. Only the opt-in emulated test may set them (see G1b below) |

Versioning plus the lock object keeps noncurrent versions of `*.tflock` as well as of the state. The spike saw three noncurrent lock versions after two applies. A lifecycle rule that removes noncurrent `*.tflock` versions after a few days is an owner choice for the bootstrap. It must never match `*.tfstate`.

### Deletion-unit labels

GCP calls tags on resources **labels**. The product's one tag scheme (`src/teardown/unit.ts`) maps to labels unchanged:

| Product tag key | GCP label key | Value |
| --- | --- | --- |
| `alz-managed-by` | `alz-managed-by` | `alz` |
| `alz-unit` | `alz-unit` | `alzu-` plus 20 hex characters |
| `alz-build` | `alz-build` | `alz-pilot-<env>-<12 hex>` |

- The scheme already restricts values to `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`. Every value is therefore a valid GCP label value (lowercase letters, digits, `-` and `_`, at most 63 characters), and every key a valid label key (starts with a lowercase letter).
- The operator's provider block declares them as `default_labels`. The google provider merges them into each labelable resource's `terraform_labels` attribute.
- At seal, the driver reads `terraform_labels` in the plan. A missing, foreign or unknown label is `UNIT_LABEL_MISSING`, `UNIT_LABEL_FOREIGN` or `UNIT_LABEL_UNVERIFIABLE`, mirroring the AWS tag codes.
- Resources no label can reach are listed in the sealed artifact so approvers see them, as on AWS. These include IAM bindings, API enablement and some networking objects.
- Resources whose labels live under another attribute name (`resource_labels`, `user_labels`) need an explicit per-type rule in the provider spec. Until a type has one, it counts as unreachable.
- A label stays a pointer, never ownership evidence.

### Protected classes (classification parity)

A pilot cleanup never deletes these, directly or as a dependent. This mirrors the plan's "Cleanup of pilot-created resources", item 3, and owner decision 5.

| Class | GCP objects |
| --- | --- |
| ordinary (deletable when run-owned) | organization policies (`google_org_policy_policy` and the legacy `google_*_organization_policy` types) that this run created. The bootstrap's own `iam.disableServiceAccountKeyCreation` policy is not in the pilot's state and is never proposed |
| `PROTECTED_BACKEND` | the state bucket, in every form its identifier takes: `<bucket>`, `gs://<bucket>`, `projects/_/buckets/<bucket>`, `//storage.googleapis.com/projects/_/buckets/<bucket>`, and every object, ACL, IAM binding and notification on it |
| `PROTECTED_IDENTITY` | every IAM object: `google_*_iam_member`, `_binding` and `_policy` at any level; service accounts and their keys; custom roles; workload identity pools and providers; IAM deny policies (`google_iam_deny_policy`); Cloud Identity groups and memberships (`google_cloud_identity_*`); Access Context Manager access levels (`google_access_context_manager_access_level`, `_access_levels`) |
| `CONTAINS_OTHERS` | VPC Service Controls perimeters (`google_access_context_manager_service_perimeter*`), API enablement (`google_project_service`), Deployment Manager deployments, Infrastructure Manager deployments, and projects, folders and the organization |

Classification is by Terraform type and by the full resource name, so a type the table does not know is never assumed to be ordinary. The provider spec ships the exact type list with a test per class.

### Approver roles

Unchanged from AWS (`docs/act-pilot-aws-terraform-g0.md`, "Approver roles"). Approvals are Ed25519 signatures by keys on the contract's allowlist, never a typed name. The roles are:

- pilot owner;
- operator;
- DEV approver;
- QA approver (chain only);
- production approvers 1 and 2 (chain only);
- qualifier;
- cleanup owner.

Two GCP differences:

- the qualifier attests from **Cloud Audit Logs**, not CloudTrail. Data Access audit logs for Cloud Storage must be enabled on the DEV project, or the state reads and writes are not logged;
- the operator holds four credential configurations and token files rather than role ARNs.

The requester-is-not-an-approver rule is the plan's (authority item 3, being amended by #286) and is out of this page's scope.

### Rollback and partial-failure behavior

The same driver, the same outcomes and the same ledger as AWS (`docs/act-pilot-aws-terraform-g0.md`, "Rollback and partial-failure behavior"; `src/apply/driver.ts`). There is no automatic rollback. The outcomes are `SUCCEEDED`, `FAILED_NO_CHANGE`, `PLAN_STALE`, `PARTIAL_REQUIRES_REVIEW` and `KILLED`. A retry is always a new preview with new approvals. The spike checked the engine text that `classifyApply` matches against the `gcs` backend:

- **Stale plan:** first line `Error: Saved plan is stale`.
- **Held lock:** first line `Error: Error acquiring the state lock`, with `googleapi: Error 412: Precondition failed` and a `Lock Info` block.

GCP specifics the review must know:

- **A SIGKILL leaves the lock object in place.** The next run is refused until a person reviews and removes it. The spike used `terraform force-unlock` against the emulator, which stays outside the pilot.
- **A graceful stop (SIGINT) releases the lock** and records what had run (the serial moves), as with Azure.
- **Unreachable Google endpoints make the backend retry without a bound.** With no emulator and every outbound host refused, a `plan` did not end in four minutes, and SIGTERM started a graceful shutdown that did not finish. The driver's 30-minute limit and its SIGKILL of the process group are what end such a run.

## Gap assessment, G0 to G5

Evidence from a fake engine or an emulator is synthetic and never counts as live (`AGENTS.md`).

| Gate | Exists | Engineering gap | Owner item |
| --- | --- | --- | --- |
| G0 | this page; the PLAN and its approval (6433121154); the G-7 spike (`docs/act-pilot-simulation-gcp.md`) | none after this page merges | assign the roles; choose the execution host; name the one change, the APPLY role set and the cleanup owner |
| G1 | none for GCP | the provider spec (`GCP` in `ProviderId`, target shape, backend check, identity variables, the key-file refusal, `google-beta` refusal, label check, protected classes) with its denial-path tests, mirroring the AWS and Azure tests | none |
| G1b | the G-7 answer: the `gcs` backend honors `STORAGE_EMULATOR_HOST` against fake-gcs-server | an opt-in emulated test of the real Terraform binary and fake-gcs-server through the driver, as `test/apply-emulated.test.ts` does for Azure. The emulator variable is allowed inside that test harness only | none for the simulation |
| G2 | none | `./alz apply qualify` and `preflight` for GCP; the GCP bootstrap | the DEV project, the bootstrap (pool, provider, four service accounts, bucket, org policy, audit logs, budget), four credential configurations and token files, a qualifier, one supervised DEV apply recorded with `record-live` |
| G3 | release admission reads the same pin | `act:gcp-terraform` in `config/release/scope.json` and `config/release/status.json` (BLOCKED, synthetic) | the pin commit |
| G4 | the promotion chain, provider-independent | the QA and PROD projects and buckets | later, out of the DEV pilot |
| G5 | `./alz apply record-recovery`, provider-independent | none beyond G1 | demonstrate a recovery on the real project |

## Every owner-supplied item, mapped

Identifiers only. No token, key or secret value is ever written into the contract or shown to this product.

| Owner item | Contract field or check (proposed) | Notes |
| --- | --- | --- |
| The reviewed `policyVersion` | `policyVersion` | as on AWS |
| The DEV project id (QA and PROD for the chain) | `targets.<ENV>.projectId` | three environments must differ in project and bucket |
| The region | `targets.<ENV>.region` | the provider block's `region` must equal it |
| The state bucket and prefix | `targets.<ENV>.backend` as `<bucket>/<prefix>` | versioned, uniform access, public access prevention on |
| The workspace | `targets.<ENV>.workspace` | `default` unless the owner decides otherwise |
| Approvals per environment, approval lifetime, approvers, kill switch path | `requiredApprovals`, `maxApprovalAgeMinutes`, `approvers[]`, `killSwitchPath` | as on AWS |
| The workload identity pool and OIDC provider | not a field | bootstrap; the provider's attribute condition pins the exact subject for each identity |
| The four service accounts and their impersonation grants | `ALZ_<IDENTITY>_GCP_SERVICE_ACCOUNT` | each federated principal may impersonate its own account only (`roles/iam.workloadIdentityUser` on that account) |
| The APPLY role set | the bootstrap and this page | named roles on the DEV project; `roles/owner` refused |
| The credential configurations and token files | `ALZ_<IDENTITY>_GCP_CREDENTIAL_CONFIG_FILE` | `external_account` only; four distinct files; never a key file |
| `iam.disableServiceAccountKeyCreation` enforced on each pilot project | not a field; a `preflight` item | decision 3 |
| Cloud Storage Data Access audit logs on | not a field | needed for the qualifier's attestation |
| Budget and label defaults | the bootstrap and the project's `default_labels` | the three `alz-*` labels |
| The execution host, pilot scope and cleanup owner | this page | as on AWS |

## The owner's checklist (after the engineering slices land)

Each step is the owner's, or done by a person the owner names. No agent performs any of them. The checklist cannot start until G1 and G1b exist for GCP.

1. Assign the roles, choose the execution host, and write down the one change, the APPLY role set and the cleanup owner.
2. Create or verify the DEV project with a budget alert.
3. Run the GCP bootstrap with a separately held administrative identity. It creates the pool and provider, the four service accounts and impersonation grants, the versioned bucket, the key-creation org policy and the audit-log configuration. Place the four credential configurations and token files on the execution host.
4. Fill a copy of the GCP example contract with `enabled: false`, and run `./alz apply contract-check` until it reports COMPLETE.
5. Set the identity variables and run `./alz apply preflight --environment DEV`.
6. Wait for G1b, the GCP emulated simulation, to pass.
7. Review, set `enabled: true`, run `./alz apply pin`, and commit the contract and pin in one reviewed change. This step enables the pilot, and it is the owner's alone.
8. Have the qualifier run `./alz apply qualify` and attest from Cloud Audit Logs.
9. Supervise one DEV apply in one channel, and record it with `./alz apply record-live`.
10. Separately authorize the live cleanup.
