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

## Drift

`./alz qualify aft-lza-drift --card config/aft-lza-card.json --output .runs/qualification/aft-lza-drift.json` reads the estate
the card describes and reports every difference between the approved sources and what AWS reports
(`src/aft-lza/drift.ts`). Detection only. It never starts a drift detection, never repairs, never re-runs a pipeline, and
never authorizes anything. Each finding names the system that owns the fix:

| Kind | Signal | Owner |
|---|---|---|
| `LANDING_ZONE` | Control Tower `get-landing-zone` `driftStatus` | Control Tower |
| `BASELINE` | `list-enabled-baselines` `driftStatusSummary` on the card's OU (an OU with no baseline is UNKNOWN) | Control Tower |
| `CONTROL` | `list-enabled-controls` `driftStatusSummary` on the card's OU | Control Tower |
| `LZA_STACK` | CloudFormation `StackDriftStatus` of `AWSAccelerator-*` stacks in every card Region | LZA |
| `ACCOUNT_PLACEMENT` | The account's parent OU against the card | LZA |
| `LZA_UNDEPLOYED` | LZA configuration branch head (GitHub) against the last successful `AWSAccelerator-Pipeline` revision | LZA |
| `AFT_UNDEPLOYED` | AFT request branch head (GitHub) against the last successful `ct-aft-account-request` revision | AFT |
| `AFT_CUSTOMIZATION` | The latest `<account>-customizations-pipeline` execution | AFT |

A signal that could not be read, or that AWS reports as `NOT_CHECKED`, `NOT_CHECKING` or `UNKNOWN`, is UNKNOWN, never IN_SYNC.
DRIFTED outranks UNKNOWN in the verdict. A denied pipeline read is an error, not "no executions". When none of the last 25
executions succeeded, the result is UNKNOWN rather than DRIFTED, because older history was not read. Exit codes are 0 for in
sync, 3 for drifted, 2 for unknown, and 1 for an error. The report records the `sts get-caller-identity` ARN the reads ran as.

Known limits:
- `LZA_STACK` reads the stacks visible to the drift role's account (the LZA home account). Stacks LZA deploys into member
  accounts need a per-account read role, which is not built yet.
- `StackDriftStatus` is only as fresh as the last drift detection the owner ran. `NOT_CHECKED` is reported as UNKNOWN so it
  stays visible.
- The `AWSAccelerator-` prefix is LZA's default. A customized prefix is not supported yet.

## GitHub Actions

`.github/workflows/aft-lza-drift.yml` runs drift detection every six hours and on demand:

- The workflow is `contents: read` at the top level. The job adds only `id-token: write`, for AWS OIDC, and `issues: write`,
  for the drift issue. Every action is pinned by SHA.
- It runs in the protected environment `aft-lza-drift`, with these settings:
  - variables `AFT_LZA_DRIFT_ROLE_ARN` (the read-only role), `AFT_LZA_HOME_REGION` and `AFT_LZA_CARD` (`config/<card>.json`);
  - optional secret `AFT_LZA_GITHUB_READ_TOKEN`, a read-only fine-grained token or GitHub App token for the LZA and AFT
    repositories. Without it, the two `*_UNDEPLOYED` findings are UNKNOWN.
- AWS access uses a web identity token file (`AWS_WEB_IDENTITY_TOKEN_FILE` + `AWS_ROLE_ARN`). No access keys are exported,
  and the token file is deleted after the read.
- It writes the job summary and uploads the JSON and Markdown report as an artifact. It opens or comments on one issue
  labeled `aft-lza-drift` when the verdict is not IN_SYNC, and closes that issue when the estate is back in sync. The job
  fails unless the verdict is IN_SYNC.

The drift role's trust policy should pin `token.actions.githubusercontent.com:sub` to
`repo:<owner>/<repo>:environment:aft-lza-drift`. Its permissions should be read-only:
- `controltower:ListLandingZones`, `GetLandingZone`, `ListEnabledBaselines` and `ListEnabledControls`;
- `organizations:DescribeOrganizationalUnit`, `ListAccounts` and `ListParents`;
- `cloudformation:DescribeStacks`;
- `codepipeline:ListPipelineExecutions`.

Repairs stay with their owners: LZA through `AWSAccelerator-Pipeline`, AFT through its pipelines, and Control Tower through
re-registering the OU or resetting the landing zone. Each repair is approved by a person.
