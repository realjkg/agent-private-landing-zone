# Observe and cleanup

**Status:** the core in `src/observe/` is wired into the apply driver (`src/apply/observe.ts`, `cleanup-proposal.ts`, `leftovers.ts`, `run-records.ts`, `runCleanup` in `driver.ts`), into `./alz apply` (`observe`, `propose-cleanup`, `approve` of a proposal, `cleanup`, `verify-cleanup`, `report`) and into the console's step 7, **Check and clean up**, for the AWS Terraform row of the journey matrix (`config/acceptance/journeys.json`). The Azure Terraform and AWS CDK rows refuse with `CLEANUP_NOT_SUPPORTED` until their own slices. Every check is a read as the DISCOVERY identity. The one mutation, the targeted destroy of an approved proposal, runs under the pilot contract and its gates (`docs/act-pilot-plan.md`, "Cleanup of pilot-created resources"; commands in `docs/act-pilot-apply.md`, "Cleanup"). ACT stays DISABLED: the shipped pin is empty, and agents never initiate an observe, a proposal, an approval or a cleanup.

Every result in this repository is **synthetic**: the tests run a fake `terraform` and a fake `aws` program. In a lifecycle report each stage carries its own evidence mode: the execute step is `LIVE` only when the owner's `record-live` attestation covers that exact apply evidence, and every other stage is `SYNTHETIC` until an attestation form exists for it, so a report is `MIXED` at best today and `LIVE` never by declaration.

## What it answers

| Step | Question | Module |
| --- | --- | --- |
| Observe | After an apply, does every resource the plan left in place exist in AWS, under the identifier the engine recorded, and is nothing else carrying this run's tag? | `blueprint.ts`, `verify.ts` |
| Cleanup | Afterwards, is every resource either gone, or kept by a named owner for a stated reason? | `disposition.ts` |

## Blueprint

`blueprintFromTerraformState` reads `terraform show -json` of the state after the apply and the sealed plan's redacted changes.

- **What it records:** each managed resource's address, type, ARN and the provider's `id`. Both identifiers are kept because Cloud Control names some types by one and some by the other.
- **What it never copies:**
  - any other attribute value. Tests check this with canary values;
  - the `id` of types whose id is a credential identifier, such as `aws_iam_access_key`;
  - the state text in a parse error.
- **Data sources and outputs:** skipped.
- **`missing`:** every address the plan says should exist afterward (created, updated, replaced or unchanged) that the state does not hold.
- **`origin`:** `NOT_IN_PLAN` marks a resource that is in the state but that the plan never mentioned.

## Independent verification

`observeBlueprint` is independent of the engine:

- It asks the AWS Cloud Control API (`cloudcontrol get-resource`) whether each resource exists under its primary identifier (`CLOUD_CONTROL_TYPES`).
- It lists resources tagged with the run's deletion unit (`resourcegroupstaggingapi get-resources`, read with `src/teardown/readers.ts`) to find resources the blueprint does not name.

The caller runs the AWS CLI as the read-only DISCOVERY identity through the bounded runner. Only existence is recorded. A failure is recorded as an error class (`ACCESS_DENIED`, `THROTTLED`, `CREDENTIALS`, `TYPE_NOT_SUPPORTED`, `CLI_ERROR`), never as the cloud's message.

| Verdict | Meaning |
| --- | --- |
| `VERIFIED` | Every resource is present. Nothing planned is missing, nothing unexpected carries the tag, and the tag listing was complete. |
| `PARTIAL` | As `VERIFIED`, except that some types cannot be checked on their own, or the run carries no unit tag. Unchecked types are named, never assumed present. An example is a bucket setting such as `aws_s3_bucket_versioning`, which is not a separate cloud resource. |
| `INCONCLUSIVE` | A check could not decide (access, throttling, credentials, or a paginated listing), or the blueprint names no resources so nothing was checked. Nothing is known to be wrong. |
| `FAILED` | A resource is absent, a planned resource is missing from the state, or an unexpected resource carries the run's tag. |

**The unit tag:** a pilot run stamps its deletion unit on everything it creates (`src/apply/unit.ts`; the operator's provider configuration declares the tags and `seal` verifies them in the plan, docs/act-pilot-plan.md item 6). The blueprint record carries the unit, so the observation lists resources carrying it and reports `inventory: COMPLETE` when the listing covered every page; a tagged resource the state does not name is `unexpected` and the verdict `FAILED`. A run whose engine seals no unit (CDK) reports `inventory: NOT_AVAILABLE` and reaches `PARTIAL` at best.

## The Azure reader

For the Azure Terraform row the same checks read Azure Resource Manager (`src/observe/azure-rest.ts`), in process, as the DISCOVERY identity. No `az` CLI runs, so no credential ever reaches a process argument list, a child environment, a log or an evidence digest:

- The DISCOVERY identity's federated token (`ALZ_DISCOVERY_ARM_OIDC_TOKEN_FILE`) is exchanged once, in the body of one HTTPS POST to `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token` (client credentials with a client assertion), for an access token scoped to `management.azure.com`. Both tokens live in memory for one observation and are dropped with it; they never appear in a record, a message or an error. Failures are recorded as classes (`CREDENTIALS`, `ACCESS_DENIED`, `THROTTLED`, `HTTP_ERROR`, `HOST_REFUSED`, `UNEXPECTED_RESPONSE`, `READER_CLOSED`). A closed reader exchanges no token again and reads nothing.
- Requests are GETs to `https://management.azure.com` only: the provider's API versions once per resource type (stable versions only; a type offered only in preview is `TYPE_NOT_SUPPORTED`), one resource by its ARM id (`200` whose `id` is the one asked about → present; `404` → absent; anything else → unknown with a class), the subscription's resources and resource groups carrying the `alz-unit` tag, and a resource group's members, every page. The one gate every request passes binds the method to the host: a POST goes only to this tenant's token endpoint, a GET only to `management.azure.com`, both over `https:` with no port and no userinfo. A listing's `nextLink` is followed only when it continues exactly the listing that was asked for: an allowed ARM URL with the same path (the same subscription, collection or group) and the same query (every original parameter, the tag filter and the API version among them, with exactly the same values the same number of times, keys compared case-insensitively) plus paging parameters (`$skiptoken`, `$skip`, `$top`), each once. A link anywhere else (another host, plaintext, a port, the login host), to another subscription or group, or one that drops, changes or repeats the filter or the API version or adds any other parameter, ends the listing as incomplete and is never followed, so the bearer never leaves over any other path and a page can never widen or narrow the inventory while the result reads complete. A page that is not an object with an array `value` of items each carrying a non-empty `id` fails the listing, and a page that names its continuation under any other key (`@odata.nextLink`) is incomplete: a malformed answer never reads as "nothing here" or as the last page. Only existence and identifiers are kept.
- An ARM id is sent exactly as written or not at all: an id with an empty, `.` or `..` segment, a backslash, a percent escape or whitespace is `NOT_AN_ARM_RESOURCE_ID` (URL parsing would rewrite it, and a `404` for the rewritten path would read as this resource's absence), and the request path is asserted equal to the id before it is sent. The proposal refuses such an id outright (`OWNERSHIP_AMBIGUOUS`): a state that holds one is reviewed by hand.
- ARM ids are case-insensitive, so the unit-tag sweep folds case for Azure only. AWS identifiers are compared exactly: an ARN that differs from a known one only in case names another resource (queue, topic and function names are case-sensitive) and stays a stray.
- A resource group is a container, recognized by the ARM id the state recorded (`/subscriptions/<id>/resourceGroups/<name>`), whatever Terraform type created it (`azurerm_resource_group`, `azapi_resource`, a module's own type). The observation lists what a deletion of each present group would take with it (`groups` in the record, every page): its top-level tracked resources, and the extension resources at its scope that the group's deletion also removes (role assignments, policy assignments, locks and policy exemptions whose id lies under the group; assignments inherited from above are not the group's and are left out by their id). A denied or failed listing of any of these five collections makes the group's listing failed or incomplete, never empty. Accepted limitation, recorded for the owner: other extension classes at group scope (for example PIM eligibility and assignment schedules) are not enumerated; they grant or exempt a scope that ceases to exist with the group, and nothing else. A material-risk note names template deployments by Terraform type and by ARM type (`Microsoft.Resources/deployments`, so an `azapi_resource` deployment too). The proposal deletes a group only when every listed member is a resource of this run that is deleted with it; otherwise the group is kept with ownership `CONTAINS_OTHERS` and the reason (foreign contents, or an incomplete listing). The cleanup lists each proposed group again before anything is reserved, and once more after the engine's destroy plan right before the approvals are consumed, refusing `PROPOSAL_SCOPE_MISMATCH` when a member appeared since or `OBSERVATION_INCONCLUSIVE` when the listing fails. A group is never deleted on run ownership alone, and the azurerm provider's own guard is not relied on. A subscription (by id or alias), a management group, or an entry of type `azurerm_subscription`, `azurerm_subscription_alias`, `azurerm_management_group` or `azurerm_management_group_subscription_association` is never proposed, whoever created it: nothing here can list what deleting it would take, so it is excluded as `CONTAINS_OTHERS`.
- Observation records now carry `groups`; a record written before this field existed is refused on read-back (fail closed): observe the run again before proposing a cleanup.
- Leftover bases name the API that answered: `ARM_ABSENT` / `ARM_PRESENT` for Azure, `CLOUD_CONTROL_ABSENT` / `CLOUD_CONTROL_PRESENT` for AWS.
- Checkable: a resource group, or a resource under a provider namespace at subscription or resource-group scope in the target subscription. Not checkable: an id outside the subscription (`OUTSIDE_TARGET_SUBSCRIPTION`), a data-plane URL such as a key vault secret (`NOT_AN_ARM_RESOURCE_ID`), or an entry with no id.
- Protected on Azure, whoever created it: the backend storage account named by any environment's `<storage-account>/<container>/<key>` in every form its id takes (the account name, an ARM id under `/storageAccounts/<account>`, or a data-plane URL `https://<account>.blob|dfs|file|queue|table|web.core.windows.net/...`, which the azurerm provider uses for containers and blobs), every `azurerm_storage_*` entry naming it, and the resource group that holds it when the state names the account's ARM id (`PROTECTED_BACKEND`); every `azuread_*` object, user-assigned identities, federated credentials, role assignments and role definitions (`PROTECTED_IDENTITY`: an identity or a grant needs its own decision).
- Tests (`test/apply-cleanup-azure.test.ts`, `test/ui-channel.test.ts`) run a scripted Azure Resource Manager with canary token values and prove that the values appear in no recorded request URL, record, result or error, that only the token POST and GETs to the two hosts are sent and a link anywhere else is never followed, that a rewritable id is never requested, and that the observation, proposal, containment rule, cleanup and leftover check behave as on AWS. Synthetic evidence only.

## Cleanup disposition

`cleanupDisposition` runs the same existence check after cleanup. Each resource ends in exactly one of these states:

| Disposition | Meaning |
| --- | --- |
| `DELETED` | The cloud says the resource no longer exists. |
| `RETAINED` | It is kept by a named owner, for a reason of at least ten characters. |
| `LEFTOVER` | It still exists and nobody kept it. |
| `UNPROVEN` | The check could not decide, or the type cannot be checked. It is never called deleted. |

- **Verdicts:**
  - `LEFTOVERS` when a resource of this run still exists and nobody kept it. That includes a resource still carrying the run's unit tag that the state never named.
  - `CLEAN` only when all of these hold:
    - the blueprint names at least one resource;
    - every resource is `DELETED` or `RETAINED`;
    - no planned resource was left unmapped;
    - no kept resource is reported gone;
    - a complete tag listing found nothing else of this run.
  - `INCONCLUSIVE` otherwise, with `unresolved` saying why. Completion is never reported in that case.
- **Timing:** the tagging API can keep listing a resource for a short time after it is deleted. A check run straight after a destroy can therefore report `LEFTOVERS` that clears on a later run. That fails closed.
- **Scheduled deletion:** a resource that deletes on a schedule, such as a KMS key in `PendingDeletion`, is read through its per-type state property (`CLOUD_CONTROL_TYPES[...].pendingDeletion`). It is `UNPROVEN` here and `DELETION_PENDING` in the leftover check, never deleted and never a plain leftover.
- **Which blueprint to use:** the one recorded when the journey was observed. A blueprint rebuilt from the state after a destroy is empty, and an empty blueprint is never `CLEAN`. A pilot run reports `INCONCLUSIVE` until the apply path tags its resources with a deletion unit.
- **Refused retention decisions:** a decision for a resource that is not part of this journey, a decision without an owner or a reason, or a resource kept twice.

## The run records

The driver and the commands keep the journey's records in the apply ledger (`.runs/apply/evidence/`), each bound to the one before it by hash. None holds an attribute value, a state document, a credential or a cloud error message.

| Record | Written by | Bound to | Replaced? |
| --- | --- | --- | --- |
| `<artifact>.apply.evidence` | the apply | the sealed plan | never |
| `<artifact>.blueprint.evidence` | the apply, from a `state pull` as STATE when it ends | the apply evidence hash | never |
| `<artifact>.observation.evidence` | `observe` | the blueprint hash | each observation |
| `.runs/apply/cleanup/<proposal12>.cleanup-proposal.json` | `propose-cleanup` | the apply evidence, blueprint and observation hashes | a new proposal is a new file |
| `<proposal>.cleanup.evidence` | `cleanup` | the proposal hash | never (a proposal runs once) |
| `<proposal>.leftovers.evidence` | `verify-cleanup` | the proposal hash and the cleanup evidence, when it exists | each check |

## The proposal

`buildCleanupProposal` (`src/apply/cleanup-proposal.ts`) turns the records into the exact list a cleanup may delete. The file it writes is a reviewable copy, not the authority: `runCleanup` reads the blueprint and the observation back from the ledger, requires them to hash to what the proposal names, rebuilds the proposal from them and the sealed plan's change list, and requires the rebuilt proposal to hash to the one handed in, before anything is reserved or any approval is consumed. It fails closed with `PROPOSAL_INVALID`, `OBSERVATION_INCONCLUSIVE` or `OWNERSHIP_AMBIGUOUS` when the apply was not `SUCCEEDED`, a planned resource never reached the state, the observation is `FAILED` or `INCONCLUSIVE`, or a resource's origin cannot be told. Each resource in the state ends in one ownership class: `RUN_CREATED` (deleted), `PRE_EXISTING`, `REPLACED_PRE_EXISTING`, `IMPORTED` and `NOT_IN_PLAN` (kept, with the reason), and `PROTECTED_BACKEND` or `PROTECTED_IDENTITY` for the state bucket and its settings, the pilot's roles and the OIDC trust (never deleted by a cleanup). Material risks, such as a bucket with objects or a key, are named for the approvers. The approvals required are the contract's for that environment; they are signed under the cleanup domain, so an apply approval never authorizes a cleanup and a cleanup approval never authorizes an apply.

## The leftover check

`verifyLeftovers` (`src/apply/leftovers.ts`) asks Cloud Control about every proposed resource after the cleanup, or before it to see what a cleanup would face. Each ends `CONFIRMED_DELETED`, `INTENTIONALLY_RETAINED`, `STILL_PRESENT`, `DELETION_PENDING` or `UNKNOWN`, with a next action for a person. A setting whose parent is confirmed gone counts as gone (`PARENT_ABSENT`); a setting whose own check cannot run and whose parent is not confirmed gone is `UNKNOWN`, also when it was already absent at proposal time. The record's disposition is `COMPLETE` only when every proposed deletion is confirmed gone or retained by name **and** a complete sweep by the run's deletion-unit tag found nothing else of this run outside the state. When the run carries no unit tag the sweep is `NOT_AVAILABLE` and the most the record says is `KNOWN_ADDRESSES_CONFIRMED`: the named resources are settled, resources outside the state were not searched for, and the cleanup is not independently complete (the #235 contract). `INCOMPLETE` otherwise. The validator refuses a `COMPLETE` without a complete sweep.

## The report

`./alz apply report` builds the lifecycle acceptance report (`src/apply/lifecycle-report.ts`) from the records: stages execute, observe, propose, cleanup and leftovers, each `PASS`, `FAIL`, `INCONCLUSIVE` or `NOT_RUN` with the hash of the record it rests on. Each stage carries its evidence mode (`SYNTHETIC` or `LIVE`) and the report's mode (`SYNTHETIC`, `MIXED`, `LIVE`) is derived from them. `passed` is derived from the stages and the validator refuses a declared pass, a declared mode, a `LIVE` stage other than the execute step, a `LIVE` execute step without the owner's attestation of this very apply evidence, or any raw state, output or secret field. The journey matrix and `config/release/status.json` cite the report's tests for the `act:aws-terraform` gate. The leftovers stage passes only on `COMPLETE`; `KNOWN_ADDRESSES_CONFIRMED` is `INCONCLUSIVE` with the missing sweep named, so a run without a unit tag never passes.

## Not covered here

- **Untaggable types.** A created resource whose type carries no tags (a bucket's versioning setting, a role assignment) is listed as untagged in the sealed artifact and is covered by the per-resource checks only; a sweep cannot find an orphan of such a type.
- **The CDK engine** seals no unit (its change set view carries no tags), so its cleanup is `KNOWN_ADDRESSES_CONFIRMED` at best until it has a tag reader.
- **AWS CDK.** It has no tag reader and no cleanup adapter; the commands refuse with `CLEANUP_NOT_SUPPORTED` and nothing runs.
- **Azure identity objects and grants.** Every `azuread_*` object, user-assigned identities, federated credentials, role assignments and role definitions are never deleted by a cleanup (`PROTECTED_IDENTITY`), whoever created them; an identity or a grant needs its own decision.
- **Azure resources without an ARM id.** A key vault secret, a key, a certificate or anything else whose state `id` is a data-plane URL cannot be read by the Azure reader: it is `UNVERIFIABLE` (`NOT_AN_ARM_RESOURCE_ID`) in the observation, proposed as such, and `UNKNOWN` after a cleanup unless a confirmed-gone parent speaks for it, so a run that created one never reaches `COMPLETE` without a person's confirmation.
- **Live acceptance.** Running the journey against a real account, the owner's `record-live` attestation, and the teardown of the pilot accounts are the owner's, under `docs/act-pilot-plan.md`. No test here is live evidence.

Tests: `test/observe-blueprint.test.ts` (the core), `test/apply-cleanup.test.ts` (the driver and records, including forged proposals), `test/apply-cleanup-cli.test.ts` (the commands and the report) and `test/ui-channel.test.ts` (the console journey). All use a fake AWS CLI and a fake Terraform, so they are synthetic evidence. The blueprint parser is also checked against real `terraform show -json` and `terraform state pull` output from Terraform 1.16.4.
