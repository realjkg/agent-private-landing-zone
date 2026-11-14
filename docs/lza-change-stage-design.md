# LZA and AFT change and cleanup stages: design

Status: proposal (docs only). No code, no live cloud access, no merge or pipeline start by the runner.

## Problem

`src/flow/one-flow.ts` reports the LZA/AFT path as `BLOCKED` at two steps: `NO_LZA_CHANGE_STAGE` and `NO_LZA_CLEANUP_STAGE`.

For the change step, the stage already exists. `aws-aft-lza` walks the whole forward path: it offers the LZA change, takes the merge commit from the person, observes the LZA pipeline and the new account, then does the same for the AFT request, the account's customizations pipeline and the controls. It ends PASS only at `VERIFIED`. The gap is in the one-flow, which reports the change step blocked without reading that stage's journal.

For the cleanup step, the gap is real. No stage removes an account's AFT registration or its LZA entry.

## What already exists

- `./alz evidence init | run | status` (`src/cli/evidence.ts`). This is the runner's single entry point. No second CLI is planned.
- The `aws-aft-lza` stage (`src/evidence-runner/aft-lza.ts`, with `src/aft-lza/run.ts`), which observes, journals, asks the person for each merge commit, and reaches `VERIFIED` once the controls are confirmed.
- A write-ahead operation store (`src/aft-lza/operation-store.ts`). Intent is written with an exclusive create before a person is asked to act. A receipt holds identifiers only. A repeated run reconciles instead of repeating an action. This covers the durable correlation requirement.

## Proposed change for the change step

No new stage. The one-flow judges the LZA/AFT change step from the live journal record of `aws-aft-lza`, the same way it judges the Terraform path from `act:<path>`:

- DONE only when the last live run of `aws-aft-lza` finished PASS.
- NEXT when no live run is recorded.
- BLOCKED when the last live run ended FAIL or BLOCKED, or stopped mid-step.

Account creation stays with LZA through `accounts-config.yaml`. AFT registration follows only after the LZA operation succeeded, which `decideNext` already enforces. The runner never starts a pipeline, invokes a Step Function, or merges.

## Cleanup stage (built)

Built as `aws-aft-lza-removal` (`src/aft-lza/removal.ts`, `src/evidence-runner/aft-lza-removal.ts`), in AWS's documented order: the person merges the AFT account-request deletion, unmanages the account in Control Tower, then merges the LZA change that moves it under the ignored OU. The stage confirms the account sits under that OU and ends `RETIRED`. Closing the account stays the owner's decision. See `docs/aft-lza-act-workflow.md`, "Removal".

## Acceptance

- Offline: a synthetic run of each step, including an interrupted run and an unauthorized run, labelled SYNTHETIC.
- The one-flow reports the change step as `DONE` only after a live PASS of `aws-aft-lza` at the current candidate commit.
- No live AWS evidence is claimed until the owner runs the stage on the owner's account.

## Open questions

- Should the change stage require a second approver for PROD? Assumed no for DEV, yes for PROD, matching `src/apply/approval.ts`.
- Is GitHub the accounts-config source? Assumed yes, as recorded in the project memory.
