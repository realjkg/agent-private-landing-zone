# LZA and AFT change and cleanup stages: design

Status: proposal (docs only). No code, no live cloud access, no merge or pipeline start by the runner.

## Problem

`src/flow/one-flow.ts` reports the LZA/AFT path as `BLOCKED` at two steps: `NO_LZA_CHANGE_STAGE` and `NO_LZA_CLEANUP_STAGE`. The read-only `aws-aft-lza` stage observes pipelines and journals intent, but no stage carries a change through to a verified result or back out again.

## What already exists

- `./alz evidence init | run | status` (`src/cli/evidence.ts`). This is the runner's single entry point. No second CLI is planned.
- The `aws-aft-lza` stage (`src/evidence-runner/aft-lza.ts`), which observes, journals, and asks the person for the merge commit.
- A write-ahead operation store (`src/aft-lza/operation-store.ts`). Intent is written with an exclusive create before a person is asked to act. A receipt holds identifiers only. A repeated run reconciles instead of repeating an action. This covers the durable correlation requirement.

## Proposed scope for the change stage

The change stage covers account creation through LZA only. AFT registration and cleanup come later as separate stages.

1. Read the card (`config.aws.aftLzaCard`) and validate it with `validateCard`.
2. Observe the LZA pipeline and its accounts-config source (read-only).
3. Journal the LZA change intent in the operation store.
4. Ask the person to merge the approved change, then type the merge commit at the terminal.
5. Observe the LZA pipeline run until it reports a terminal state. Record its identifiers as a receipt.
6. Stop. The runner never starts a pipeline, invokes a Step Function, or merges.

Each step is idempotent through the operation store. An interruption at any point resumes by reconciling, never by repeating an external action.

## Proposed scope for the cleanup stage

Cleanup runs in reverse order: AFT registration is removed before LZA. It follows the same intent, merge, observe, and receipt pattern. It is out of scope until the change stage has passed its offline rehearsal.

## Acceptance

- Offline: a synthetic run of each step, including an interrupted run and an unauthorized run, labelled SYNTHETIC.
- The one-flow reports the stage as `DONE` only after a receipt exists at the current commit.
- No live AWS evidence is claimed until the owner runs the stage on the owner's account.

## Open questions

- Should the change stage require a second approver for PROD? Assumed no for DEV, yes for PROD, matching `src/apply/approval.ts`.
- Is GitHub the accounts-config source? Assumed yes, as recorded in the project memory.
