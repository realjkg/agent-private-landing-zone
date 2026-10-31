# G0 package: Azure Terraform DEV pilot, and the owner-input kit

Status: G0 is a documentation gate ("Docs only; no heavyweight run", `docs/act-pilot-plan.md`). This page covers path 3 of the narrow ACT-DEV release, Azure Terraform (owner decision on 2026-10-27, issue #39, comment 6443352284; the DEV-only scope for Azure Terraform is owner decision 6442856302). It records the provider and engine, the approver roles, the rollback and partial-failure behavior, the minimal workload, and the review of the DISCOVERY scope. It then lists every input only the owner can supply, and the offline command that reports what a draft contract still lacks. It is modeled on the AWS page (`docs/act-pilot-aws-terraform-g0.md`). Where the two paths are the same, this page points to that one rather than repeating it.

Nothing on this page enables ACT. The repository ships no pilot contract (the old `config/act-pilot-contract.sha256` pin is removed; the contract's `authorize` entry is the switch), and the product's ACT default stays DISABLED. Agents never hold approver keys and never initiate an apply (`AGENTS.md`, the ACT amendment). Enabling the pilot is, and stays, the owner's reviewed commit of the contract with its `authorize` entry, followed by an owner-supervised DEV apply (`docs/act-pilot-apply.md`, "The contract is the authorization"). Nothing here has run against Azure. Every statement about Azure behavior below is either cited to the code or marked UNVERIFIED.

People are never named here. Where a person is needed, the text uses a role and the placeholder `<name>`.

## G0 decisions

### Provider and engine

| Decision | Value | Where it is bound |
| --- | --- | --- |
| Provider | `AZURE` with the AzureRM state backend | the contract's `provider`, validated against `src/apply/providers/azure.ts` (`docs/act-pilot-apply.md`, "Azure") |
| Engine | `TERRAFORM` | the contract's `engine`, validated against `src/apply/engines/terraform.ts`, with its pinned argument lists in `src/apply/terraform.ts` (Terraform 1.16.4 only) |
| Pilot scope | the DEV-only pilot (`"enabledEnvironments": ["DEV"]`), one additive change (the workload below), in one DEV subscription | the contract: a DEV-only contract carries exactly `targets.DEV` and `requiredApprovals.DEV`. The validator accepts this scope for AWS Terraform and Azure Terraform (#298; `src/apply/contract.ts`). The sealed plan's change list is what the approver signs |
| Identities | four Entra app registrations used through federated credentials, with no client secret or certificate: DISCOVERY, STATE, STATE_WRITE, APPLY. Each identity uses the same client in every environment (`principalPerEnvironment: false`) | `ALZ_<IDENTITY>_ARM_CLIENT_ID`, `_ARM_TENANT_ID`, `_ARM_SUBSCRIPTION_ID`, `_ARM_USE_OIDC=true`, `_ARM_OIDC_TOKEN_FILE` on the execution host. These are checked by `./alz apply preflight` and attested by `./alz apply qualify` from the Entra sign-in logs and the storage logs |
| State | one storage account and container per environment, with versioning and soft delete on. Shared keys and SAS are disabled, so only Entra ID authorization works. The lock is a lease on the state blob | the contract's `backend` (`<storage-account>/<container>/<key>`) and the STATE_WRITE partial backend configuration at `init`. Backend pinning is on `main` (#297, `docs/act-pilot-backend-pinning.md`): the product writes its own `azurerm` backend override and every setting comes from its `-backend-config` file. Still owed: the Entra-only state authentication setting, which a new lane is delivering as one PR on top of the backend pinning (it replaces #287/#289) |
| Bootstrap | `bootstrap/azure` in DEV-only mode (`enabled_environments = ["DEV"]`, #304), or the three-subscription chain | `docs/act-pilot-bootstrap.md`, Step 1 |
| Channel | the terminal or the console wizard, chosen when the workflow starts and sealed into the plan, never mixed | `docs/act-pilot-apply.md`, "Channels" |

The contract shape for this decision is `config/act-pilot-contract.azure-dev.example.json`. It is an example only: the loader reads `config/act-pilot-contract.json` and nothing else, and it can never enable ACT: `enabled` is false; `policyVersion`, the tenant ID, the subscription ID, the authorized `location` and the approver's id and public key are `REPLACE-WITH-...` placeholders; and the backend names the fake `examplefakedevstate` storage account. Its workspace (`default`), `requiredApprovals.DEV` (1), `maxApprovalAgeMinutes` (30) and kill switch path (`.runs/apply/KILL`) are usable defaults that the owner confirms. The owner's copy lives at `config/act-pilot-contract.json`, which is not committed until the reviewed pin commit.

### The minimal workload

The workload is **one empty, tagged virtual network in the pilot resource group that `bootstrap/azure` creates** (`apply_resource_group_name`, for example `rg-alz-pilot-dev`). The run creates no resource group. This is the coordinator's default under "no deadlock on progress" (issue #39, comment 6444382695, items 1 and 2), and the owner may override it. Path 4 (Azure Bicep / ARM) uses the same workload. The project is a single root module with no data sources and no modules. The shape below is illustrative: the operator writes the real one, and `seal` judges it. Its lock file must pin `hashicorp/azurerm` at exactly 4.81.0, the version the pilot's denied-type lists were reviewed against; `./alz apply prepare` and the seal refuse any other (`PROVIDER_VERSION_NOT_REVIEWED`, `docs/act-pilot-apply.md`, "Provider versions are bound to the review").

```hcl
terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "= 4.81.0"                                              # exactly the reviewed version: prepare and seal refuse any other
    }
  }
}

provider "azurerm" {
  features {}
  tenant_id                       = "<the contract's tenantId>"        # constants: seal checks them against the contract
  subscription_id                 = "<the contract's subscriptionId>"
  resource_provider_registrations = "none"                              # required: see below
}

locals {
  unit_tags = { "alz-managed-by" = "alz", "alz-unit" = "<from ./alz apply prepare>", "alz-build" = "<from ./alz apply prepare>" }
}

resource "azurerm_virtual_network" "pilot" {
  name                = "vnet-alz-pilot-dev"
  resource_group_name = "rg-alz-pilot-dev"                              # the bootstrap's pilot group, a constant
  location            = "<the contract's location>"                  # a constant: seal and apply refuse any other, or an unknown one
  address_space       = ["10.250.0.0/24"]                               # the owner picks a range that overlaps nothing
  tags                = local.unit_tags
}
```

The backend block and its settings follow `docs/act-pilot-apply.md`. The seal requires every created resource that has a `tags` attribute to carry exactly the unit's three tags. It refuses a missing, foreign or computed tag with `UNIT_TAG_MISSING`, `UNIT_TAG_FOREIGN` or `UNIT_TAG_UNVERIFIABLE` (`docs/act-pilot-apply.md`, "The deletion unit").

**Why this shape.**

1. **APPLY stays on one resource group.** The bootstrap gives APPLY a custom role with exactly the network's read, write and delete, and DISCOVERY Reader, on the pilot group alone (owner decision of 2026-10-28; `docs/act-pilot-bootstrap.md`, "APPLY's role (Azure)"). APPLY holds no Contributor and cannot create, change or delete a group, so a workload that created its own group would be refused by ARM. Every environment must set `apply_resource_group_name`.
2. **The location is bound** (owner decision of 2026-10-28). The contract's `targets.DEV.location` is the authorized region (`bootstrap/azure` outputs it in `contract_targets` as the pilot group's region). The seal and the apply refuse a network planned anywhere else, or one whose location is unknown until apply (`LOCATION_NOT_IN_CONTRACT`), so write it as a constant; the observation checks the created network's own location again (`docs/act-pilot-apply.md`, "Azure location").
3. **The governed cleanup removes everything the run created.** The cleanup never deletes a resource group (`RETAINED_GROUP`, `src/apply/cleanup-proposal.ts`; `docs/act-pilot-apply.md`, "Cleanup"). Because the run creates none, `verify-cleanup` can confirm the virtual network gone. The pilot group itself belongs to the bootstrap, and its teardown (`docs/act-pilot-bootstrap.md`, "Teardown") removes it.
4. **`resource_provider_registrations = "none"` is required.** The azurerm provider (4.x) registers a set of resource providers when it starts unless this is set. The plan runs as DISCOVERY, which holds Reader and cannot register anything. Registration is therefore a one-time prerequisite: the owner registers, once, in the DEV subscription, every resource provider namespace the bootstrap and the workload use:

   | Namespace | Used by | Note |
   | --- | --- | --- |
   | `Microsoft.Storage` | bootstrap: the state storage account and container | `docs/act-pilot-bootstrap.md`, Step 1 |
   | `Microsoft.Network` | workload: the virtual network | the only namespace the workload adds |
   | `Microsoft.Consumption` | bootstrap: the subscription budget | only when `budget_monthly_amount` is set |
   | `Microsoft.Resources` | bootstrap: the state and pilot resource groups | registered by default in every subscription; check, do not register |
   | `Microsoft.Authorization` | bootstrap: the four role assignments | registered by default in every subscription; check, do not register |

   The app registrations, service principals and federated credentials are Entra (Microsoft Graph) objects, not resource providers. Check with `az provider show --namespace <namespace> --query registrationState`; register with `az provider register --namespace <namespace> --wait`. The bootstrap's own azurerm provider keeps its default registration behavior, because it runs as the administrator. Only the pilot project sets `"none"`. UNVERIFIED: the exact startup behavior of the pinned azurerm version, and whether Reader alone covers the provider's other startup reads.
5. **The reader's subscription-scope reads are a live-evidence item.** The observation lists unit-tagged resources and groups, and reads provider API versions, at subscription scope (`src/observe/azure-rest.ts`). It does this while DISCOVERY's Reader is on the pilot group only. Whether Azure answers those reads, or refuses them, is UNVERIFIED and is not claimed here. It is recorded for the owner-supervised DEV run (issue #39, comment 6444382695, item 3). A refused read fails closed: it is `UNKNOWN` or an incomplete listing, never absence.

The pilot therefore does not exercise the creation of a container. That is accepted for DEV.

### Approver roles

The roles, their contract fields and the rules the driver enforces are the same as for AWS: see `docs/act-pilot-aws-terraform-g0.md`, "Approver roles". Approvals are Ed25519 signatures by allowlisted keys, never a typed name. The requester signs the sealed request. In PROD, the requester can never approve. Azure differs in one way:

- **Qualifier** `<name>` runs `./alz apply qualify` on the execution host against the real Terraform. From the Entra sign-in logs and the storage account's logs, the qualifier attests `SEPARATED <STATE_WRITE client id> <APPLY client id>`: state reads and writes by STATE_WRITE or STATE only, and no state access by APPLY or DISCOVERY. Qualify runs nothing as APPLY, so APPLY's provider access is checked at the first supervised DEV apply. Whether the plan-time and apply-time backend authenticates as STATE_WRITE or falls back to APPLY's `ARM_*` is an open real-cloud question (`docs/act-pilot-apply.md`, "Open item that blocks live apply").

For the DEV-only pilot, the minimum is three people: a pilot owner, an operator and a DEV approver. The owner is free to hold more than one role.

### Rollback and partial-failure behavior

This is the same driver, outcomes and ledger as for AWS: see `docs/act-pilot-aws-terraform-g0.md`, "Rollback and partial-failure behavior". In short:
- There is no automatic rollback.
- Gates that refuse before the engine runs consume nothing.
- Once `terraform apply` starts, the outcome is one of `SUCCEEDED`, `FAILED_NO_CHANGE`, `PARTIAL_REQUIRES_REVIEW` or `KILLED`.
- After a non-success outcome, `errored.tfstate` and `crash.log` are kept in the encrypted vault.
- Recovery is a person's review followed by a new preview.

Azure specifics:

- **State lock.** The lock is a lease on the state blob. `FAILED_NO_CHANGE` is only a lock refusal with the serial unmoved. A lease left behind by a `KILLED` run is released by hand, after review, as STATE_WRITE (never APPLY) with `terraform force-unlock <LOCK_ID>` (`docs/act-pilot-apply.md`, "Recovering a state lock left by a SIGKILL"). Run it from an address in the state storage account's `state_allowed_ip_ranges`, with Entra ID authentication only: never loosen the network rule or enable shared-key access to unlock. The product never runs `-lock=false` or `force-unlock`.
- **Recovery reads.** The owner reads the state as an administrator, outside the pilot's identities, along with the resources, the activity log and the sign-in logs.
- **Reversal.** Reversal is the governed cleanup (`observe`, `propose-cleanup`, `approve`, `cleanup`, `verify-cleanup`). It reads Azure Resource Manager in process as DISCOVERY (`src/observe/azure-rest.ts`). It never deletes the backend storage account, a resource group, deployment history, or anything under `Microsoft.Authorization` or `Microsoft.ManagedIdentity`.

## DISCOVERY scope review (Z4)

The owner decided that read-only discovery defaults to control-plane metadata. It excludes application data and secret contents, and any exception needs an explicit scope and purpose (issue #39, comment 6440801434, item 2). The authoritative statement for Azure is the **Azure** paragraph of `docs/act-pilot-bootstrap.md`, "Read-only discovery scope" (#293): DISCOVERY holds the built-in Reader role on the pilot scope and no role on the state container; Reader grants control-plane `*/read` actions and no data actions; ARM still returns resource configuration. This section expands that paragraph for path 3, in the same terms. It was done offline, from the role's definition and the product's code. **It was not checked on a live subscription.**

**What DISCOVERY holds.** `bootstrap/azure` assigns the built-in **Reader** role at the pilot scope: the pilot resource group, or the subscription when `apply_resource_group_name` is omitted. DISCOVERY has no role on the state container. Reader's definition is `actions: ["*/read"]`, with no `notActions`, no `dataActions` and no `notDataActions`.

**No data actions, confirmed.**

- **No data actions.** Reader cannot read blob, queue or table data, or Key Vault secret, key or certificate values (reading a secret's ARM resource returns its attributes, not its value).
- **No `listKeys` or SAS.** `listKeys`, `listAccountSas` and the other `.../list*/action` operations are actions, not reads. So Reader cannot obtain a storage key or SAS, and the state accounts allow neither anyway.
- **Token audience.** The product's own reads as DISCOVERY use a token for `management.azure.com`, and no data plane accepts it (`src/observe/azure-rest.ts`).

**What control-plane reads still return.** `*/read` matches every read action of every resource provider, and ARM still returns resource configuration. A few of those control-plane reads return content beyond names and settings. Per the published operation lists, these include:

1. **Log and telemetry contents.**
   - `Microsoft.OperationalInsights/workspaces/query/*/read` lets the holder query a Log Analytics workspace (application and audit logs) through Azure Resource Manager.
   - `Microsoft.Insights/components/query/read` does the same for Application Insights.
   - `Microsoft.Insights/eventtypes/values/read` reads the activity log, with caller identities and client IP addresses.
2. **Configuration values that can carry data.**
   - Deployment history (`Microsoft.Resources/deployments/read`) records non-secure parameter values and the outputs of past deployments; a `secureString` parameter is not returned.
   - Automation reads return unencrypted variable values.
   - Container instance reads return non-secure environment variables.
   - API Management reads return non-secret named values.
   - Logic App definitions can embed parameter values.

   Values marked secure or secret are not returned in any of these.
3. **Scope.** At subscription scope, all of this covers every workload in the subscription, not just the pilot's. At resource-group scope, it covers only what is in the pilot group.
4. **What the product itself needs.** These reads are listed below, and none of them is in items 1 or 2.
   - The observation reads one resource by id.
   - It reads the provider's API versions (`/subscriptions/<id>/providers/<namespace>`).
   - It lists the resources and resource groups that carry the unit tag at subscription scope (`/subscriptions/<id>/resources`, `/subscriptions/<id>/resourcegroups`).
   - The Terraform plan refreshes the project's own resources. For the workload above, that is one virtual network.

   UNVERIFIED: whether the two subscription-scope listings and the provider read succeed with Reader on the resource group only, or are refused. A refused read surfaces as `UNKNOWN` or an incomplete listing, never as absence, so it fails closed. It is a live-evidence item for the owner-supervised DEV run ("The minimal workload", item 5).

**Finding.** Reader is control-plane only: it has no data actions, so it reads no blob data and no Key Vault secret values. Within the control plane, items 1 and 2 can return content, and the scope bounds that. In the pilot resource group, which holds only the pilot's own resources, there are no application logs or workload configuration to read. At subscription scope in a shared subscription, there would be.

**Decision for DEV (issue #39, comment 6444382695, item 4).** For DEV the built-in Reader stays, on the pilot resource group, and is treated as control-plane metadata under the owner decision of 6440801434, as `docs/act-pilot-bootstrap.md` states. The pilot group holds only the pilot's own resources, so items 1 and 2 have nothing to expose there. The narrower role below is a documented decision for QA and PROD, not a DEV blocker.

**Proposal for QA and PROD (documented only; nothing in the bootstrap changes).** Replace Reader with a custom role that allows exactly the reads the product makes as DISCOVERY. This mirrors the AWS inline allow (`bootstrap/aws/discovery-policy.json`):

```json
{
  "Name": "ALZ Pilot Discovery",
  "Description": "Control-plane reads the ALZ pilot makes as DISCOVERY (proposed for QA and PROD). No data actions.",
  "Actions": [
    "Microsoft.Resources/subscriptions/read",
    "Microsoft.Resources/subscriptions/resourceGroups/read",
    "Microsoft.Resources/subscriptions/resources/read",
    "Microsoft.Resources/subscriptions/resourceGroups/resources/read",
    "Microsoft.Resources/subscriptions/providers/read",
    "Microsoft.Resources/tags/read",
    "Microsoft.Network/virtualNetworks/read"
  ],
  "NotActions": [],
  "DataActions": [],
  "NotDataActions": [],
  "AssignableScopes": ["/subscriptions/<QA subscription id>", "/subscriptions/<PROD subscription id>"]
}
```

- **Verify every action name first.** UNVERIFIED: each action name must be confirmed with `az provider operation show --namespace Microsoft.Resources` and `--namespace Microsoft.Network` before use, and the provider-metadata read in particular.
- **The list follows the project.** Each further resource type the pilot project creates adds its own `.../read` action, by a reviewed change. A type that is not listed fails closed at plan time with `AuthorizationFailed`.
- **Cost of the change.** It needs `Microsoft.Authorization/roleDefinitions/write` for the owner, and one more reviewed list to keep in step with the workload.
- **Lighter alternative.** Keep `*/read` and add `NotActions` for the items above. This is weaker: like the AWS deny list, it removes only what it names.

The choice is the owner's, and it is made before QA or PROD.

## Gap assessment, G0 to G5

This lists what exists for Azure Terraform today, what engineering still owes, and what only the owner can provide. Evidence from a fake engine or an emulator is synthetic and never counts as live (`AGENTS.md`).

| Gate | Exists (cite) | Engineering gap | Owner item |
| --- | --- | --- | --- |
| G0 | this page; the provider and engine specs; `config/act-pilot-contract.azure-dev.example.json`; `bootstrap/azure` | #304 (`bootstrap/azure` DEV-only mode). The DEV-only contract scope for Azure Terraform is on `main` (#298) | assign the roles; choose the execution host; confirm or override the workload; name the cleanup owner |
| G1 | the denial paths with a fake engine (`docs/act-pilot-aws-terraform-g0.md`, G1, which are shared by both providers); `test/apply-cli.test.ts` drives the Azure path end to end | none known | none |
| G1b | `test/apply-emulated.test.ts`: real Terraform against Azurite. It passed on 2026-10-27 with SAS and account keys, which the Entra-only backend refuses | backend pinning is on `main` (#297; the emulated run's SAS settings must move to a test-only backend file, `docs/act-pilot-backend-pinning.md`). Still owed: the Entra-only state authentication PR (a new lane replacing #287/#289), then the Entra-only G1b re-run (Z2) | none; the reviewed pin commit comes after it |
| G2 | `./alz apply preflight`, `prepare`, `qualify`, `record-live`; the Azure reader (`src/observe/azure-rest.ts`) | none known in the product after the items above. The open real-Azure questions in `docs/act-pilot-apply.md` are answered by the run, not by code | the DEV subscription, the bootstrap, four token files on the execution host, a person to qualify and attest from the sign-in and storage logs, one supervised DEV apply recorded with `record-live` |
| G3 | release admission reads the same contract authorization (the live record's entry hash); `config/release/status.json` carries `act:azure-terraform` and `azure-provider`; `preview:terraform-azure-brownfield` is OUT_OF_SCOPE, dropped by the owner on 2026-10-28 (#39, 6480066863) because E1 makes APPLY seals create-only | none for the DEV pilot | the authorization commit; `./alz qualify admission` after the live record |
| G4 | the promotion chain and the PROD quorum, with a fake engine | none for the DEV-only pilot | out of scope for the DEV-only pilot |
| G5 | the outcomes and ledger; `./alz apply record-recovery` | none known | demonstrate a recovery on the real subscription, or show that the failure handling held, and record it |

## The owner-input kit

### Check a draft offline

```
./alz apply contract-check --file config/act-pilot-contract.json
```

The command, its statuses (`PRESENT`, `MISSING`, `PLACEHOLDER`, `EXAMPLE`, `INVALID`, plus a `NOTICE` on a copied default) and its guarantees are described in `docs/act-pilot-aws-terraform-g0.md`, "Check a draft offline". For Azure, it lists `targets.DEV.tenantId` and `targets.DEV.subscriptionId` in place of the account and region. The example's `REPLACE-WITH` tenant and subscription are `PLACEHOLDER`, and its `examplefake` storage account is `EXAMPLE`. A filled DEV-only Azure draft is COMPLETE, and a QA target beside the DEV one is refused (`test/apply-contract-check.test.ts`).

### Every owner-supplied item, mapped

These are identifiers and public keys only. No private key, token, client secret or other secret value is ever written into the contract or shown to this product.

| Owner item | Contract field or check | Notes |
| --- | --- | --- |
| The reviewed `policyVersion` | `policyVersion` | as for AWS |
| The Entra tenant ID | `targets.DEV.tenantId` | a GUID; every identity's `ALZ_<IDENTITY>_ARM_TENANT_ID` must equal it |
| The DEV subscription ID | `targets.DEV.subscriptionId` | a GUID; every identity's `ALZ_<IDENTITY>_ARM_SUBSCRIPTION_ID` must equal it, as must the provider block's constant |
| The state storage account, container and key | `targets.DEV.backend` as `<account>/<container>/<key>` | `bootstrap/azure` output `contract_targets.DEV`; versioning on, keys and SAS disabled |
| The workspace | `targets.DEV.workspace` | `default` unless the owner decides otherwise |
| The approvals DEV needs | `requiredApprovals.DEV` | at least 1 |
| The approval lifetime | `maxApprovalAgeMinutes` | 1 to 1440 |
| Each approver: id, Ed25519 public key (PEM), environments | `approvers[]` | ids and keys unique; the private key stays with the approver |
| The kill switch path | `killSwitchPath` | the owner creates and removes the file |
| The STATE_WRITE binding | `embedStateWrite: true` | required, as for AWS; no identity may carry a client secret (`ARM_CLIENT_SECRET` is refused) |
| The four app registrations and their federated credentials | `ALZ_<IDENTITY>_ARM_CLIENT_ID` on the execution host | `bootstrap/azure` output `identity_client_ids`; one subject per identity |
| The token files on the execution host | `ALZ_<IDENTITY>_ARM_OIDC_TOKEN_FILE` | absolute paths, four distinct files |
| The pilot resource group (the APPLY and DISCOVERY scope) | the bootstrap (`apply_resource_group_name`) | required by the workload; see "The minimal workload" and the DISCOVERY review |
| Budget, retention, tags | the bootstrap's variables | the deletion-unit tags go on every resource in the project (`tags`) |
| The execution host, the pilot scope, the cleanup owner | this page (G0) | as for AWS |
| A person to qualify | `./alz apply qualify` and the `SEPARATED` attestation | from the Entra sign-in logs and the storage logs |

### The owner's checklist to enable ACT on Azure Terraform DEV

These steps are in order. Each is done by the owner or by a person the owner names. No agent performs any of them. Engineering prerequisites still owed: the Entra-only state authentication PR (a new lane replacing #287/#289), the Entra-only G1b re-run, and #304 for the DEV-only bootstrap. Backend pinning (#297) and the DEV-only contract scope (#298) are on `main`.

1. Assign the roles. Choose the execution host. Confirm the workload. Name the cleanup owner.
2. Provide a DEV subscription dedicated to the pilot, with a budget and alerts (`docs/act-dev-enablement.md`).
3. Run `bootstrap/azure` in DEV-only mode (`docs/act-pilot-bootstrap.md`, Step 1) with `apply_resource_group_name` set, using a separately held administrative identity. Register the namespaces listed under "The minimal workload", item 4 (`Microsoft.Network`, `Microsoft.Storage`, and `Microsoft.Consumption` with a budget). Place the four token files on the execution host.
4. Copy `config/act-pilot-contract.azure-dev.example.json` to `config/act-pilot-contract.json`. Fill it from `terraform output -json` and the table above, keeping `enabled: false`. Run `./alz apply contract-check --file config/act-pilot-contract.json` until it reports COMPLETE.
5. Set the twenty `ALZ_<IDENTITY>_ARM_*` variables on the execution host. Run `./alz apply preflight --environment DEV`: every item except qualification should be READY.
6. Wait for the Entra-only G1b (engineering's, not the owner's).
7. Review the values, set `enabled: true` and `"authorize": { "DEV": ["APPLY", "CLEANUP"] }`, and commit the contract in one reviewed change. This is the step that enables the pilot, and it is the owner's alone.
8. Have the qualifier run `./alz apply qualify` against the real Terraform on DEV and attest from the logs.
9. Supervise one DEV apply (`prepare`, `seal`, `approve`, `apply`) in one channel. Record it with `./alz apply record-live --sealed SEALED_PLAN`.
10. Separately authorize the live cleanup. The pilot resource group stays until the bootstrap teardown.
