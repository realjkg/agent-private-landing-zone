# Observe and cleanup

**Status:** part 1 of the slice. The core in `src/observe/` is wired into the apply driver (`src/apply/observe.ts`, `cleanup-proposal.ts`, `leftovers.ts`, `run-records.ts`, `runCleanup` in `driver.ts`) for the AWS Terraform row of the journey matrix (`config/acceptance/journeys.json`). Part 2 adds the commands (`./alz apply observe`, `propose-cleanup`, `approve` of a proposal, `cleanup`, `verify-cleanup`, `report`), the console's step 7, **Check and clean up**, the lifecycle report and the matrix rows; the command names below describe that part. The Azure Terraform and AWS CDK rows refuse with `CLEANUP_NOT_SUPPORTED` until their own slices. Every check is a read as the DISCOVERY identity. The one mutation, the targeted destroy of an approved proposal, runs under the pilot contract and its gates (`docs/act-pilot-plan.md`, "Cleanup of pilot-created resources"; commands in `docs/act-pilot-apply.md`, "Cleanup"). ACT stays DISABLED: the shipped pin is empty, and agents never initiate an observe, a proposal, an approval or a cleanup.

Every result in this repository is **synthetic**: the tests run a fake `terraform` and a fake `aws` program. A lifecycle report says `mode: LIVE` only when the owner's `record-live` attestation covers that exact apply evidence.

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

`./alz apply report` builds the lifecycle acceptance report (`src/apply/lifecycle-report.ts`) from the records: stages execute, observe, propose, cleanup and leftovers, each `PASS`, `FAIL`, `INCONCLUSIVE` or `NOT_RUN` with the hash of the record it rests on. `passed` is derived from the stages and the validator refuses a declared pass, a `LIVE` mode without the owner's attestation of this very apply evidence, or any raw state, output or secret field. The journey matrix cites the report's tests; `config/release/status.json` cites the report path for the `act:aws-terraform` gate.

## Not covered here

- **Untaggable types.** A created resource whose type carries no tags (a bucket's versioning setting, a role assignment) is listed as untagged in the sealed artifact and is covered by the per-resource checks only; a sweep cannot find an orphan of such a type.
- **The CDK engine** seals no unit (its change set view carries no tags), so its cleanup is `KNOWN_ADDRESSES_CONFIRMED` at best until it has a tag reader.
- **Azure Terraform and AWS CDK.** Their verifiers and cleanup adapters are later slices; the commands refuse with `CLEANUP_NOT_SUPPORTED` and nothing runs.
- **Live acceptance.** Running the journey against a real account, the owner's `record-live` attestation, and the teardown of the pilot accounts are the owner's, under `docs/act-pilot-plan.md`. No test here is live evidence.

Tests: `test/observe-blueprint.test.ts` (the core) and `test/apply-cleanup.test.ts` (the driver and records, including forged proposals); part 2 adds `test/apply-cleanup-cli.test.ts` (the commands and the report) and the console journey in `test/ui-channel.test.ts`. All use a fake AWS CLI and a fake Terraform, so they are synthetic evidence. The blueprint parser is also checked against real `terraform show -json` and `terraform state pull` output from Terraform 1.16.4.
