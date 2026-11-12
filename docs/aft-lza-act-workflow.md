# AWS Control Tower + LZA + AFT pilot workflow (`act:aws-aft-lza`)

One controlled, demoable workflow inside the existing evidence runner. No second CLI, engine or approval system.

```
./alz evidence run --stage aws-aft-lza
```

## Sequence

AWS's pattern ([Deploying custom Terraform to LZA-managed accounts with AFT](https://aws.amazon.com/blogs/mt/deploying-custom-terraform-to-lza-managed-accounts-with-aft/)) is sequential, and so is this stage:

1. **LZA** — the person merges the approved `accounts-config.yaml` change; the stage binds the `AWSAccelerator-Pipeline` execution whose source revision is that merge commit. An unrelated or older execution never advances the run.
2. **Identity gate** — the account is read from Organizations by email; id, name, email, OU and `ACTIVE` status must match the card. Unreadable is `UNRESOLVED`, never a mismatch and never a pass. AFT stays blocked until this passes.
3. **AFT** — the person merges the approved `aft-account-request` entry (name and email must equal the LZA entry, checked offline); the stage binds the `ct-aft-account-request` execution to that commit.
4. **Customization** — the account's `<id>-customizations-pipeline` must succeed. On failure the stage enters `RECOVER_CUSTOMIZATION`; the only recovery write is `aft-invoke-customizations` with `{"include":[{"type":"accounts","target_value":["<id>"]}]}`, scoped to the one account, after the previous invocation is reconciled, at most 3 attempts (`checkReinvocation`).
5. **Verification** — read-only control observations in every card Region. Pipeline success is not verification; simulated or unknown observations keep the run `UNRESOLVED`.

Disposition is **RETAIN**. Removal (AFT first, then LZA) is out of scope. Drift is routed to its owning system (`routeDrift`); overlap or unknown ownership is a conflict; nothing is auto-adopted or auto-repaired.

## Who does what

| Actor | May | Never |
|---|---|---|
| Runner (`aws-aft-lza`) | Read pipelines, account and controls under the federated DISCOVERY identity; decide; journal intent; ask for a merge commit | Merge, start a pipeline, invoke a Step Function, hold a credential, write the pilot contract |
| Person at the terminal | Merge each approved change; type the merge commit; run the scoped re-invocation | — |
| Owner | Write `config/act-pilot-contract.json` and its authorization | — |

The stage is in `READONLY_STAGES`: preflight refuses it beside any mutation identity. It is never in `DEFAULT_STAGES`.

## Restart and reconciliation

Each write (`<runId>:lza`, `<runId>:aft-registration`) gets an intent file created with an exclusive create before the person is told to act, under `.runs/evidence/aft-lza/<runId>/operations/` (mode 0700, outside the per-run folder). A later run — after a crash, a lost terminal, or from another process — that finds the intent gets `RECONCILE`: look for the existing PR/merge and record its commit, never open another. A receipt holds identifiers only; keys that look like secrets are refused. Separate-process kill tests cover this.

## Inputs

`config.aws.aftLzaCard` names a card under `config/` (see `config/aft-lza-card.example.json`). Every field is checked offline first (`validateCard`); the card is blocked without validator evidence for the exact configuration digest, with a shared LZA/AFT repository, or with the home Region missing from the governed Regions.

## Evidence labels

Tests are `SYNTHETIC`. A `LIVE` run's decision document is `LIVE_READ_ONLY` — evidence of observed state, not authorization. `deploymentAuthorized` and `actStartedByRunner` are always `false`.

## Gate status

`act:aws-aft-lza` is defined by this workflow but **not yet** in `PRODUCTION_RELEASE_GATES`; adding it changes `config/release/status.json` and is an owner release decision.
