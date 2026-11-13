# The one flow

The one flow is the single ordered sequence every operator follows, whatever they type into. The terminal, the browser
console and the chat session are three ways into the same eight steps, with the same names, in the same order. Each step has
exactly one terminal command. The browser and the chat say what they do for that step, or say plainly that the step is not
theirs, so no surface invents a second journey.

`src/flow/one-flow.ts` holds the step list (`FLOW`) and `readFlow`, which reports where the checkout is in that list.

## The eight steps

| # | Step | Who | Terminal command | Optional |
|---|------|-----|------------------|----------|
| 1 | Set up this computer | You | `./alz bootstrap` | no |
| 2 | Rehearse offline | You | `./alz matrix --offline-fixture --scenario terraform-aws-brownfield` | no |
| 3 | Turn on the private models | You | `./alz models verify && ./alz matrix --live-models --scenario terraform-aws-brownfield` | yes |
| 4 | Authorize DEV | Owner | `./alz apply contract-check --file config/act-pilot-contract.json`, then the owner commits it | no |
| 5 | Describe the run | You | `./alz evidence init`, then `./alz evidence run --stage act:aws-terraform --dry-run` | no |
| 6 | Make the change | You | `./alz evidence run --stage act:aws-terraform` | no |
| 7 | Clean up and record | You | `./alz evidence run --stage cleanup:aws-terraform` | no |
| 8 | Watch for drift | You | `./alz qualify aft-lza-drift --card config/<card>.json --output .runs/qualification/aft-lza-drift.json` | yes |

Steps 1, 2, 4 and 5 are required before the change. Step 6 needs 2, 4 and 5. Step 7 needs 6. Steps 3 and 8 are optional: a
block there does not hold up the steps after it.

Surfaces: the browser console shows steps 1–8 on its Flow card, runs only the steps the console owns (for example "Rehearse offline"), and says "terminal only" for the rest. The chat answers questions
("where am I in the flow?", "am I ready to seal?", "what is left over?") and never runs, seals, approves, applies or cleans up.

## How a step is judged

`readFlow` reads local files only: files under the checkout, `git rev-parse`, `git status`, `git cat-file`. It never calls a
cloud or a model, never runs a step and never writes. A step it cannot judge from local files is not marked done.

Each step ends in one of four states:

- **DONE**: the local evidence for it exists and matches this checkout.
- **NEXT**: it can be done now and is not yet.
- **WAITING**: a step it needs is not DONE yet. The status names the step it waits for.
- **BLOCKED**: a run was recorded and it did not pass, or the journal cannot be read. A recorded block is shown even while an
  earlier step is open.

What counts as DONE:

| Step | DONE when |
|------|-----------|
| Set up | The checkout is clean (`resolveSourceCommit`, with the contract's committed text checked too) and `dist/.alz-build-complete` names HEAD. |
| Rehearse offline | A passing `OFFLINE_FIXTURE` matrix has the AWS scenario converged at HEAD. |
| Models | A passing `LIVE_PRIVATE_MODELS` matrix has the AWS scenario converged at HEAD. |
| Authorize | `config/act-pilot-contract.json` is committed, enables aws-terraform for APPLY and CLEANUP in DEV, and its kill switch is off. |
| Describe | `config/evidence-runner.json` loads and names HEAD as its candidate. |
| Make the change | The journal's last finish for `act:aws-terraform` is PASS. |
| Clean up | The journal's last finish for `cleanup:aws-terraform` is PASS. |
| Watch | A local drift report exists and was written in the last 8 hours. |

## Known limits

- The watch step says only that a local report is recent. It does not read the report's findings, and it does not see the
  scheduled GitHub Actions run (`.github/workflows/aft-lza-drift.yml`).
- The change and cleanup steps read the journal's stage-level record. They do not re-verify the cloud.
- The flow is not yet wired to a command or to the console. `readFlow` is the reader; the surfaces that show it are a later change.
- ACT is for the `aws-terraform` path. The customer's AWS direction is LZA-first (LZA creates accounts, AFT customizes existing
  ones). This flow does not model that yet; see `docs/aft-lza-act-workflow.md`.
