# Observe and cleanup

**Status:** core implemented in `src/observe/`, not yet wired into `./alz apply` or the console. It covers the observe and cleanup steps of the journey matrix (`config/acceptance/journeys.json`), starting with the AWS Terraform row. Nothing here adds authority to change infrastructure: every call is a read, and ACT stays DISABLED.

## What it answers

| Step | Question | Module |
| --- | --- | --- |
| Observe | After an apply, does every resource the plan left in place exist in AWS, under the identifier the engine recorded, and is nothing else carrying this run's tag? | `blueprint.ts`, `verify.ts` |
| Cleanup | Afterwards, is every resource either gone, or kept by a named owner for a stated reason? | `disposition.ts` |

## Blueprint

`blueprintFromTerraformState` reads `terraform show -json` of the state after the apply and the sealed plan's redacted changes.

- **What it records:** each managed resource's address, type, ARN and the provider's `id`. Both identifiers are kept because Cloud Control names some types by one and some by the other.
- **What it never copies:** any other attribute value. Tests check this with canary values.
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
| `INCONCLUSIVE` | A check could not decide (access, throttling, credentials, or a paginated listing), and nothing is known to be wrong. |
| `FAILED` | A resource is absent, a planned resource is missing from the state, or an unexpected resource carries the run's tag. |

**Known limit:** the pilot apply does not tag its resources with a deletion unit yet. Only the build path does. So a pilot run reports `inventory: NOT_AVAILABLE` and can reach `PARTIAL` at best. Tagging pilot resources is a change to the apply path.

## Cleanup disposition

`cleanupDisposition` runs the same existence check after cleanup. Each resource ends in exactly one of these states:

| Disposition | Meaning |
| --- | --- |
| `DELETED` | The cloud says the resource no longer exists. |
| `RETAINED` | It is kept by a named owner, for a reason of at least ten characters. |
| `LEFTOVER` | It still exists and nobody kept it. |
| `UNPROVEN` | The check could not decide, or the type cannot be checked. It is never called deleted. |

- **Verdicts:** `CLEAN` when every resource is `DELETED` or `RETAINED`; `LEFTOVERS` when any resource is a leftover; `INCONCLUSIVE` otherwise. A kept resource the cloud reports gone is listed in `retainedButAbsent`, and the verdict is not `CLEAN`.
- **Refused retention decisions:** a decision for a resource that is not part of this journey, a decision without an owner or a reason, or a resource kept twice.

## Not covered here

- **Executing a destroy.** `docs/act-pilot-plan.md` says an actual destroy needs its own plan after the apply pilot. No executable cleanup driver exists until its authorization contract is approved. This module checks the result of a destroy, or of resources removed by hand. It does not perform one.
- **Wiring.** The next step connects these modules to:
  - `./alz apply`: an observe step after a successful apply, under the DISCOVERY identity;
  - the console's Results and cleanup steps;
  - the journey matrix.

  The journey matrix keeps observe and cleanup at `NOT_IMPLEMENTED` until then, because a step passes only with console, positive, denied, interrupted and recovery tests.

All tests (`test/observe-blueprint.test.ts`) use a fake AWS CLI, so they are synthetic evidence. The blueprint parser is also checked against real `terraform show -json` output from Terraform 1.16.4.
