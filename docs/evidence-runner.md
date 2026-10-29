# The evidence runner: `./alz evidence`

`./alz evidence` is the owner's local runner for the live evidence that blocks a release. It runs on the owner's own machine, against the owner's own accounts, and orchestrates the evidence producers that already exist.

What it never does:

- produce a document a producer did not write;
- declare a LIVE label for the person;
- answer, pre-answer or skip any prompt or typed phrase;
- start an apply on its own;
- read, store or forward a credential.

ACT stays disabled: the runner does not change the pilot contract, its `authorize` entry or any approval. Agents never run it against accounts.

The PLAN is on the coordination ledger (issue #39, 6433527942). It follows the owner's decisions (6432901333), the delegated decisions 2 to 5 (6433391052) and the coordinator record for this build (6486460684).

## Stages

| Stage | Slice | What it does | Runs |
| --- | --- | --- | --- |
| `preflight` | S1 | Clean checkout of the candidate (or, for a guided stage, of the commit that carries one path's contract). No mutation identity beside a read-only stage. What the committed contract authorizes (shape only). Each selected provider's federated identity against the expected account. The owner inputs. Then the start attestation. | Every run |
| `aws-readonly` | S2 | Verifies the federated DISCOVERY identity names the expected account, then runs `./alz qualify provider-aws` against the owner's no-op stack | Default run |
| `azure-readonly` | S3 | Verifies the tenant and subscription, then runs `./alz qualify provider-azure` | Default run |
| `gcp-readonly` | S4 | Verifies the project, then stops `NO_PRODUCER`: no read-only GCP inventory producer exists on main | Default run |
| `act:<path>` | S5 | Guided: `./alz apply` contract-check → identity-check `--phase delivered` → prepare → qualify → preflight → seal → approve → apply → observe | Only with `--stage` |
| `cleanup:<path>` | S5 | Guided: contract-check → identity-check → the kill switch (again, now) → observe → propose-cleanup → approve → cleanup → verify-cleanup → report → record-live | Only with `--stage` |
| `recovery` | S5 | Guided: `./alz apply record-recovery` for an interrupted and a resumed sealed plan | Only with `--stage` |
| `summary` | S6 | Indexes the evidence, runs `./alz qualify admission` (read-only), and prints every gate with how a missing one is produced | Default run |

The six paths are `aws-terraform`, `aws-cdk`, `azure-terraform`, `azure-bicep`, `gcp-terraform` and `gcp-api`. Each is guided behind the same gates: the committed contract must name the path's provider and engine and authorize the operation, the configuration must name the path's project folder and requester, and a person answers every prompt. `gcp-api` (GCP API-native) produces the gate `act:gcp-gcp_api` since INT-2.

## Commands

```text
./alz evidence init [--config FILE]
./alz evidence run [--config FILE] [--stage NAME] [--dry-run] [--synthetic]
./alz evidence status [--config FILE] [--synthetic]
```

- **`init`** copies `config/evidence-runner.example.json` to `config/evidence-runner.json` (git-ignored). It never overwrites.
- **`run --dry-run`** runs the preflight and prints what each selected stage would do. It writes only `<evidenceDir>/dry-run/<candidate12>/dry-run.json` (marked `evidence: false`), a folder no run or index reads, and journals nothing.
- **`run`** runs the preflight. When it passes, `run` asks for the start attestation, then runs and journals each selected stage. Without `--stage` it runs the default stages: the three read-only stages and the summary. A guided stage runs only when it is named, because:
  - it needs the mutation identities the read-only stages refuse to run beside;
  - it needs a person typing every phrase.
- **`status`** reads the journal and prints:
  - each stage's last outcome and its document count;
  - the next default stage;
  - the owner inputs still missing;
  - how each release gate is produced.

No flag forces, skips, pre-answers or labels anything, and no flag carries a credential.

**Exit codes:**

| Code | Meaning |
| --- | --- |
| `0` | Every requested stage after the preflight produced its evidence: at least one did, and none was skipped, refused or failed. |
| `2` | Anything else, including a run that produced nothing or was refused. |
| `1` | An error. |

- A dry run exits `0` only when the preflight passes and nothing it can check in advance blocks a planned stage. It still produces no evidence. A dry run of `--stage preflight` alone exits `0` when the preflight passes, because it plans nothing that could be blocked.
- A refused write of the dry-run plan exits `2` with its code (review N2 on #292).
- The console never runs the command: its three catalog entries are handoffs, and `cli/evidence.js` can never be a console job.

## Configuration

`config/evidence-runner.json` holds identifiers only, in a closed set of keys:

| Key | What it is |
| --- | --- |
| `schemaVersion` | `1` |
| `candidateCommit` | The 40-character release candidate |
| `targetHardwareId` | This host's id, as the evidence names it |
| `evidenceDir` | `.runs/evidence` or a folder under it |
| `aws` | `expectedAccountId`, `region`, `qualificationStack` |
| `azure` | `expectedTenantId`, `expectedSubscriptionId`, `location` |
| `gcp` | `expectedProjectId`, `region` |
| `act` | `repository` (`OWNER/REPO`, where the D4 delivery workflow runs) and `paths`. Each key of `paths` is a path id. Its value names `project` (the absolute path of the canary copy outside the checkout, as each canary's README says), `requesterId` and, optionally, `approverId` (an approver who approves at this terminal). |

- **No secrets.** No credential, profile, key file or token path belongs in it.
  - An unknown key, a `REPLACE-WITH` placeholder or a credential-shaped value is refused.
  - A refusal never echoes the value.
  - Key files are asked for at the terminal each time a step needs one. Their path is passed to `./alz apply` and is never stored or journaled.
- **Missing blocks.** A missing provider block skips that provider's stage. A missing `act.paths.<path>` refuses that path's guided stages (`OWNER_INPUT_ACT_TARGETS`).
- **Where evidence goes.** Evidence is written only under the git-ignored `.runs/evidence`, so a run never dirties the checkout it is bound to. A symbolic link anywhere on that path below the repository refuses the run before anything is written (`EVIDENCE_PATH_REFUSED`). How each write is protected is under "Writes" below.

## Labels

A run is LIVE only when the person types `EVIDENCE LIVE <targetHardwareId>` at an interactive terminal after the preflight passes. `--synthetic`, or typing `SYNTHETIC`, labels the run SYNTHETIC instead:

- its files go under `<evidenceDir>/synthetic/`;
- every runner document is stamped `fixture: true`;
- its summary never submits a producer's document. Each admission record points at a fixture-stamped runner document that names the producer's file, so the release admission review refuses it.

Without a terminal and without `--synthetic`, the run is refused and nothing is written. No flag or file can declare a label.

The runner's label is about the runner's own documents. The producers keep their own attestations: `./alz apply record-live` still asks for `LIVE DEV <artifact12>`, `qualify` for its `SEPARATED …` phrase, and so on. The person types each one.

## Identities

**The most restrictive option, flagged for the owner.**

Delegated decision 2 (#39, 6433391052) allows the operator's own CLI login (`aws sso login`, `az login`, `gcloud auth`) to be used in process to verify the account and for read-only reads. However, the operator-login question (A/B/C) that held S2 (#39, 6437189291) was never closed on the ledger. Under the no-deadlock rule, this build takes the most restrictive option:

- **The runner never uses the operator's CLI login.** It does not read it, it starts no CLI to read it, and no child receives it. That login is not needed, so it is not touched.
- **Every read and every producer runs under the pilot's federated identities**, delivered by D4 (`docs/act-pilot-identity-delivery.md`).
  - When those identities are not set, the stage is BLOCKED (`FEDERATED_IDENTITY_MISSING`) and names the missing variables.
  - The runner never substitutes the operator's login.
- **Account verification happens in this process, before any read, on what the producer's tools will actually sign in with** (`src/evidence-runner/identity.ts`):
  - **AWS.** The `aws` CLI takes its DISCOVERY identity from `ALZ_DISCOVERY_AWS_ROLE_ARN` with a web identity token file. The runner checks the account in the role ARN, and the region in `ALZ_DISCOVERY_AWS_REGION`.
    - A profile, config file or shared-credentials file under any identity (`ALZ_*_AWS_PROFILE`, `_AWS_DEFAULT_PROFILE`, `_AWS_CONFIG_FILE`, `_AWS_SHARED_CREDENTIALS_FILE`) refuses the stage (`IDENTITY_NOT_FEDERATED`). It would outrank or replace the web identity in the CLI's credential chain.
  - **Azure.** `az` signs in only from `ALZ_DISCOVERY_AZURE_CONFIG_DIR`; it ignores `ARM_*`. That folder must:
    - be your dedicated folder, signed in as the federated DISCOVERY service principal (`az login --service-principal --federated-token …` into it);
    - be owned by you, mode `0700`, not a link, and its own real path;
    - hold no symbolic link anywhere inside it (every entry is checked with `lstat`, down to a bounded depth), because az reads its sign-in from several files there, and a link could point it at another folder such as your own `~/.azure`;
    - sit outside your home folder and outside the checkout, so it can never be your own `~/.azure`.

    The runner reads only that folder's `azureProfile.json`, which lists subscriptions and holds no token (az keeps tokens in `msal_token_cache.*`, which is never opened). The default subscription and its tenant must be the expected ones, and the signed-in principal must be a service principal, never a user.
    - Every subscription's `isDefault` must be a real `true` or `false`, so the runner and az cannot pick different defaults.
    - When `ALZ_DISCOVERY_ARM_CLIENT_ID` is set, the principal's client id in that profile must equal it. This is a consistency check of the folder's own file, not proof: only the token's `appid` claim, which the runner never reads, would prove which principal signed in.

    **Why the runner does not create and sign in to a fresh folder itself:** doing so would mean reading the delivered token and handing it to `az` as an argument. The runner never reads or forwards a credential.
  - **GCP.** `ALZ_DISCOVERY_GOOGLE_PROJECT` and `ALZ_DISCOVERY_GOOGLE_REGION`.
  - **Token files.** Each token or credential-configuration file is checked with `lstat` only: absolute, a regular file of this user, mode `0600` or tighter, not a link. It is never opened.
  - **Wrong account.** A wrong account, tenant, subscription, project or region refuses the run before anything is written (`WRONG_ACCOUNT`).
- **After the run, the producer's own observation.** The provider qualification document records `observedIdentity`: the account, or the tenant and subscription, its own discovery read (`sts get-caller-identity`, `az account show`). The stage takes the document as evidence only when that observation is the expected one.
  - It also records the principal: the AWS role the caller assumed, or the Azure service principal's client id. That principal must match the configured DISCOVERY role, and `ALZ_DISCOVERY_ARM_CLIENT_ID` where one is set (`PRINCIPAL_MISMATCH`, `PRINCIPAL_NOT_OBSERVED`). This is a consistency check, not proof of which principal signed in.
  - A different one gives FAIL `WRONG_ACCOUNT`.
  - A missing one gives FAIL `IDENTITY_NOT_OBSERVED`.
  - Either way the document is kept for you to read, and is not evidence.
- **What this proves.** The tools were pointed at the expected account, and the producer actually read there.
- **What it does not prove.** That the identity is the federated one and not some other service principal signed in to that folder. The folder is yours to keep dedicated.

Every runner document records the identity kind (`FEDERATED`) and the ids, never token material. If the owner later chooses to allow the operator's login for account observation, that is a separate, reviewed change to `identity.ts` only.

### What a child receives

Every producer runs as a child of the runner (`src/evidence-runner/child.ts`). The child's environment is built, never inherited:

- **Allowlisted terminal and locale variables, and `PATH`**, so `./alz` can find `node` and `git`.
- **`HOME` replaced** by the run's private, empty folder (`<run>/home`). No child can read `~/.aws`, `~/.azure`, `~/.config/gcloud` or `~/.terraformrc`.
- **The pilot's identity channel, `ALZ_*`.** A variable whose name, in any letter case, says it holds a static secret refuses the step by name (`STATIC_SECRET_REFUSED`) and is never forwarded. This covers `…_SECRET…`, `…_SESSION_TOKEN`, `…_PASSWORD`, `…_TOKEN`, `…_KEY`, `TF_TOKEN_*`, `GOOGLE_CREDENTIALS` and Terraform inputs such as `…_TF_VAR_db_password`. A file path such as `…_TOKEN_FILE` or `GOOGLE_APPLICATION_CREDENTIALS` is a reference and is forwarded.
- **`AGENTIC_EVIDENCE_KEY_FILE`**: the path of the local evidence key, as the console's job environment does. `AGENTIC_EVIDENCE_KEY` itself is never passed.
- **`AZURE_FEDERATED_TOKEN_FILE`**, for the read-only provider producers only. It is the federated marker `./alz qualify provider-azure` checks.

Everything else is dropped, including the operator's whole session: `AWS_PROFILE`, AWS keys and session tokens, `AWS_CONFIG_FILE`, `AZURE_CONFIG_DIR`, `ARM_*`, `CLOUDSDK_*`, `GOOGLE_APPLICATION_CREDENTIALS`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`, `NODE_OPTIONS` and loader variables. `test/evidence-stages.test.ts` holds that list as an oracle and checks it against real child processes. The runner's own `git` questions run with `PATH` and locale only.

The two kinds of child:

- **A read-only producer** has no input (`/dev/null`). Its output goes to a log file of the run (`<run>/logs/`), so a run stays quiet.
- **A guided step** shares the person's terminal on all three streams (`stdio: inherit`). Every `./alz apply` prompt is the product's own and is answered by the person. The runner holds no pipe to the child's input, so it cannot answer for them. A test checks that a child's standard input is the runner's own file, not a new pipe.

## The guided stages

The runner sequences the existing `./alz apply` commands. Every phrase, target confirmation and attestation is typed by you. The only things the runner asks for are:

- a key file's path, before a step that needs one (seal, propose-cleanup, and approve when `approverId` is set);
- the approval files the approvers saved.

`./alz apply approve` prints a signed approval (no secret). Save it under `.runs/`, for example `.runs/approvals/apply-1.json`, so the checkout stays clean. A question is asked only when its step will really run, before the step is journaled as started. An empty answer leaves the step unstarted.

Before the first child, the runner checks four things. Each child checks them again in full.

1. The path is available.
2. The committed contract enables the path. The contract must say `enabled: true` and name the path's provider and engine, and `authorize.DEV` must list `APPLY` (for `act:`) or `CLEANUP` (for `cleanup:`).
3. The configuration names the path's project and requester.
4. The terminal is interactive.

| Step | Command (you answer its prompts) | What it proves | What it does not prove |
| --- | --- | --- | --- |
| contract-check | `./alz apply contract-check --file config/act-pilot-contract.json` | The committed contract is complete for this path | That anyone reviewed it (the commit's review does) |
| identity-check | `./alz apply identity-check --path <path> --repository <OWNER/REPO> --phase delivered` | Every identity of the path has its own private, fresh token for its own environment and audience (HOST_LOCAL) | Cloud trust |
| prepare | `./alz apply prepare --environment DEV --project <canary copy>` | The request and manifest bind this project and the contract's target | Anything about the cloud |
| qualify | `./alz apply qualify --request … --manifest …` | The real engine and identity separation, which you attest from CloudTrail or the sign-in logs | Any apply |
| preflight | `./alz apply preflight --environment DEV --contract config/act-pilot-contract.json` | Readiness, qualification included, and the kill switch is off | Budget or cost limits |
| seal | `./alz apply seal … --requester <id> --key <key file>` | The exact plan, bound to this commit, contract and engine binary | Approval |
| approve | `./alz apply approve --bundle <review bundle> …` | The approver saw the change list and signed it | That the apply will succeed |
| apply | `./alz apply apply … --sealed … --approval …` | The DEV apply ran from the sealed plan under the approvals | That only the canary exists (observe checks that) |
| observe | `./alz apply observe --sealed …` | An independent read of what the apply created | Anything outside the engine's state |
| propose-cleanup, approve | `./alz apply propose-cleanup …`, then `approve` on the proposal | The proposal names exactly what this run created and the cloud found | Deletion |
| cleanup | `./alz apply cleanup --proposal … --approval …` | The approved resources were deleted by the targeted cleanup | That nothing else remains (verify-cleanup checks) |
| verify-cleanup | `./alz apply verify-cleanup --proposal …` | Each proposed deletion is confirmed gone, or named as retained or unknown | Environment retirement (always outstanding) |
| report | `./alz apply report --sealed … --proposal …` | The lifecycle report from the records | Live labels for the stages it marks SYNTHETIC |
| record-live | `./alz apply record-live --sealed …` (type `LIVE DEV <artifact12>`) | The `act:<path>` gate's evidence, from the apply's own ledger record | Admission (the summary runs it) |

**Why preflight comes after qualify.** `./alz apply preflight` reports "not ready" until the engine is qualified, so placing it after qualify makes it the last check before seal (`docs/act-dev-enablement.md`, step 12).

**Why record-live comes last.** `record-live` writes into `config/acceptance/evidence/`, which would make the checkout dirty, and every later step and the summary refuse a dirty checkout. So it runs last, and the runner then moves the record, byte for byte, into the stage's folder under `.runs/evidence` and checks its hash. Commit a copy and cite it in `config/acceptance/journeys.json` as before (`docs/act-pilot-apply.md`, "Recording live acceptance").

**Stopping and never repeating.** The runner stops at the first step that does not pass, and journals it.

- Any `./alz apply` exit code other than `0` is a refusal:
  - `2`: refused before any action;
  - `1`: an error;
  - `3`: spent.
- These steps can change the account, consume approvals or write a one-time record: **seal, apply, cleanup, record-live and record-recovery**. Once one has started, the runner never starts it again, whatever its result. A rerun stops with `EVIDENCE_STEP_NOT_REPEATED`. Continue by hand, as `docs/act-pilot-apply.md` "When an apply fails" says, or start a new run folder.
- Any other step that did not pass runs again on the next run, and steps that passed are reused.
- **The read-only gates are never reused.** `contract-check`, `identity-check --phase delivered` and `preflight` run again on every invocation of an `act:` stage, so a resumed stage is gated on the contract, the delivered tokens and readiness as they are now.
- **The cleanup stage re-checks only what cleanup requires.** It runs `contract-check`, `identity-check --phase delivered` and the contract's kill switch (read in this process, as the product reads it: on when its file exists or cannot be read) again on every invocation.
  - It does **not** run `./alz apply preflight`. That command reports apply readiness, which needs an engine qualification under 30 days old and an unchanged engine binary. `./alz apply cleanup` requires neither: it checks the contract's CLEANUP authorization, the identities, the delivered tokens, the targets and the kill switch (`checkEngineAndIdentities` with kind `cleanup`, `src/apply/driver.ts`).
  - So a cleanup weeks after the apply still runs. Everything cleanup itself refuses still stops the stage.
- **Ctrl-C at an `./alz apply` prompt** stops both that command and the runner, because the signal goes to the whole foreground group.
  - The product's own prompt answers nothing, so the step ends without acting.
  - The runner's journal keeps the step as started and never finished (`INTERRUPTED`).
  - A read-only step runs again on the next run. A step that can change the account (seal, apply, cleanup, record-live, record-recovery) is never started again by the runner. Check `./alz apply status`, then continue by hand or start a new run folder.

## The summary

1. **Index.** The summary reads the documents the run's producers wrote, from the journal. It also takes the owner-run evidence for this candidate and host where its producer writes it:
   - `./alz qualify ci-evidence` writes `.runs/release/ci/<gate>-<candidate12>.json` (`source-ci`, `release-archive`);
   - `./alz models verify --production` writes the newest passing record under `.runs/model-qualification/` for this `targetHardwareId` (`private-model-runtime`).

   It writes `summary/evidence-index.json` (what was found, and each missing gate with how it is produced) and `summary/admission-manifest.json`.

   Each ACT path with a live record adds an `actPilots` entry: its provider, engine, the contract hash from the live record, and the commit that carried that contract. This is the six-path form of #344.

   **How records are bound.** Every manifest record names the **candidate** as its `sourceCommit`. A live or recovery record keeps its own binding to the path's contract commit inside the document, and admission checks it against that path's `actPilots` entry (the same rule as #344 N1).

   **Hash check.** A document is submitted only while it still hashes to what the journal recorded when its step finished. A document changed since then fails the index (`EVIDENCE_DOCUMENT_CHANGED`), and nothing is submitted.
2. **Review.** `./alz qualify admission --manifest <run>/summary/admission-manifest.json` runs as a quiet child. It reads files only and writes `.runs/release/admission-<uuid>.json`.
3. **Print.** Every gate is printed with its status. A BLOCKED gate also shows how it is produced and the owner input it waits for.

The summary is PASS only when the review says the evidence is structurally present for every gate. Even then, independent review and the owner's approval are still required. Otherwise it is BLOCKED `RELEASE_BLOCKED`. Its steps run again on every run, so its verdict is always current.

## The owner run sheet

Every block below is run by the owner at their own terminal, on the MBP. None of it is run by an agent. Text after `#` is a note, not part of the command.

### Before any path

1. **The candidate.**

   ```sh
   git fetch origin && git switch --detach <candidate>
   ./alz bootstrap                         # once per checkout
   ./alz evidence init
   ${EDITOR:-vi} config/evidence-runner.json
   ```

   Replace every `REPLACE-WITH` value with your own identifiers: the candidate, this host's id, the expected account, tenant, subscription and project, the repository, and per path the canary copy and the requester id.
2. **Owner inputs.** `./alz evidence status` lists them:
   - the AWS no-op stack, created by hand from `qualification/provider/aws-noop-stack.yaml`;
   - the federated identities;
   - each path's reviewed contract commit;
   - the `act` block.
3. **Federated identities.** Use D4: `docs/act-pilot-identity-delivery.md`, sections 10 and 11.
   - Dispatch the delivery for the path you will use.
   - Export the identity variables pointing at the delivered files.
   - For the read-only stages, export **only the `ALZ_DISCOVERY_*` variables**, plus `AZURE_FEDERATED_TOKEN_FILE` for Azure. The preflight refuses a read-only stage beside a mutation identity.

### Read-only stages and the summary (the candidate)

```sh
./alz evidence run --dry-run            # the plan: every stage READY, SKIPPED or BLOCKED with its reason
./alz evidence run                      # type: EVIDENCE LIVE <targetHardwareId>
./alz evidence status
```

- **Expected:** `aws-readonly` and `azure-readonly` PASS, each with `<run>/<stage>/provider-<cloud>.json`. `gcp-readonly` is BLOCKED `NO_PRODUCER`. `summary` is BLOCKED `RELEASE_BLOCKED` until every gate has evidence.
- **AWS producer.** It needs the no-op stack and a DISCOVERY role that may read the account and preview a change set against that stack. When it may not, the producer reports BLOCKED with its blockers in its document. The runner never widens DISCOVERY.
- **Azure producer.** It runs `az` as DISCOVERY from `ALZ_DISCOVERY_AZURE_CONFIG_DIR` (`docs/runner-hardening.md`, "Giving a tool an identity").
  - Before the read-only run, sign the federated DISCOVERY service principal in to a dedicated folder (mode `0700`, outside your home and the checkout). Select the expected subscription there as its default. Never use your own `az login` folder.
  - Whether `az` keeps that sign-in fresh for the life of a delivered token is UNVERIFIED on a live tenant.

### One ACT path

Repeat for each path, one at a time:

```sh
git switch --detach <contract-commit-for-path>   # the owner's reviewed commit: the candidate plus this path's contract only
./alz bootstrap
# D4: deliver this path's identities, then export ALL of them (DISCOVERY, STATE, STATE_WRITE, APPLY; or DISCOVERY, CHANGESET, APPLY for CDK)
./alz evidence run --dry-run --stage act:<path>
./alz evidence run --stage act:<path>            # EVIDENCE LIVE <host>, then every ./alz apply prompt
# keep what the apply created as long as you want to observe it
./alz evidence run --stage cleanup:<path>        # every prompt again; record-live last (LIVE DEV <artifact12>)
./alz evidence status
```

The run folder stays `<evidenceDir>/<candidate12>` across checkouts, so one journal holds every path. The preflight accepts a guided stage at a commit that differs from the candidate in `config/act-pilot-contract.json` only.

| Path | Canary to copy outside the checkout | Identities | Checklist (not repeated here) |
| --- | --- | --- | --- |
| `aws-terraform` | `qualification/aws/act-dev1-canary` | DISCOVERY, STATE, STATE_WRITE, APPLY | [`act-dev-1.md`](act-dev-1.md), [`act-dev-enablement.md`](act-dev-enablement.md) "AWS Terraform DEV" |
| `aws-cdk` | `qualification/aws/act-dev1-cdk-canary` (`prepare` may ask for the AWS CLI version) | DISCOVERY, CHANGESET, APPLY | [`act-pilot-apply.md`](act-pilot-apply.md) "CDK" |
| `azure-terraform` | `qualification/azure/act-dev1-canary` | DISCOVERY, STATE, STATE_WRITE, APPLY | [`act-dev-enablement.md`](act-dev-enablement.md) "Azure Terraform DEV" |
| `azure-bicep` | `qualification/azure/act-dev1-bicep-canary` | DISCOVERY, APPLY | [`act-pilot-bicep.md`](act-pilot-bicep.md) |
| `gcp-terraform` | `qualification/gcp/act-dev1-canary` (set the project as its README says) | DISCOVERY, STATE, STATE_WRITE, APPLY | [`act-pilot-gcp-evidence.md`](act-pilot-gcp-evidence.md), E1 to E10 |
| `gcp-api` | `qualification/gcp/act-dev1-canary-api` (the one `request.json`) | DISCOVERY, APPLY | [`act-pilot-gcp-evidence.md`](act-pilot-gcp-evidence.md), F1 to F10 |

**Expected per path:**

- `act:<path>` PASS `APPLIED_AND_OBSERVED`.
- `cleanup:<path>` PASS `CLEANED_AND_RECORDED`, with the live record under `<run>/cleanup-<path>/`.
- The journal lists every step's exit code and every document's path and hash.

The pilot's denial, replay and interruption checks are in each checklist. The runner does not run them.

### Recovery, CI gates, model acceptance, then the summary again

```sh
./alz evidence run --stage recovery              # after a real interrupted apply and a new approved one; you name both sealed plans
./alz qualify ci-evidence --gate source-ci --run <run id> --artifacts <folder>        # and --gate release-archive
./alz models verify --production                 # on this host
git switch --detach <candidate> && ./alz bootstrap
./alz evidence run --stage summary
```

### Resume

Rerun the same command. Stages and steps that passed are reused. A step that can change the account, consume approvals or write a one-time record is never started twice. `./alz evidence status` shows where the run stands.

- **Mismatches.** A journal of another candidate, configuration, host or label is refused (`EVIDENCE_JOURNAL_MISMATCH`). Move the folder aside to start again.
- **Kill switch.** The contract's kill switch stops seal, apply and cleanup inside the children. Remove it by hand only (`docs/act-pilot-apply.md`, "Kill switch").

### Cleanup and retention

- **Cloud resources.** What an apply created stays until `cleanup:<path>`. That stage deletes only what the approved proposal names.
- **Verification.** `verify-cleanup` confirms each deletion or names what is retained. Environment retirement stays outstanding by design.
- **Evidence retention.**
  - Keep `<evidenceDir>/<candidate12>/` with the candidate: the journal, stage documents, producer documents, logs and the admission manifest.
  - The encrypted ledger under `.runs/apply/` holds the apply and cleanup evidence that `record-live`, `report` and admission read again.
  - Nothing under `.runs/` is committed. The live records are committed by the owner as before.
- **Local working files.** `./alz apply propose-removal` / `remove-workspace` remove one run's preparation files and scratch directories, under the same approvals (`docs/act-pilot-apply.md`, "Removing a run's working files"). The runner does not run them.
- **Delivered tokens.** End the D4 delivery (`touch <root>/<path>/RELEASE`), then run `./alz apply identity-check --phase cleaned`.

## Owner inputs

Some inputs only the owner can supply (delegated decision 3). The runner lists each one with its BLOCKED reason and never supplies it:

- **`OWNER_INPUT_NOOP_STACK`**: the AWS no-op qualification stack. The runner only previews it through the producer, under the federated identity; it never creates, updates or deletes it.
- **`OWNER_INPUT_FEDERATED_IDENTITY`**: the federated DISCOVERY identity of each read-only stage, and every identity of a guided stage (D4).
- **`OWNER_INPUT_AUTHORIZATION`**: the owner's reviewed commit of each path's pilot contract with its `authorize` entry. The runner reads its shape only. `AUTHORIZATION_PRESENT` once it is there.
- **`OWNER_INPUT_ACT_TARGETS`**: the `act` block of the configuration.

## Gates with no producer

Every production release gate is mapped (`src/evidence-runner/gates.ts`). The runner reads the gate ids from `config/release/status.json` and derives each mode from its id, so it never loads the gate registry module, which loads the pilot apply path. At run time it checks `status.json` against a committed copy of the registry's ids (`src/evidence-runner/gate-ids.ts`). A missing, unknown, repeated or reordered gate, or a scope exclusion naming no gate, refuses the run and `status` with `EVIDENCE_RELEASE_GATES_MISMATCH`, naming the ids. A test pins that copy and every derived mode to the registry.

A gate with no producer on main reports `NO_PRODUCER`, and the runner writes nothing for it, never a placeholder (delegated decision 4). Their producers belong to a new PLAN. These gates are:

- `gcp-provider`: no read-only GCP inventory producer;
- `arm64-final-image`;
- `isolated-recovery`;
- `lifecycle:clean-install`, `lifecycle:upgrade`, `lifecycle:rollback`, `lifecycle:uninstall` and `lifecycle:configuration-migration`;
- `security-review:independent`.

These gates are owner steps the summary does not run itself:

- **`source-ci` and `release-archive`**: `./alz qualify ci-evidence`, merged in #274. The summary indexes what it wrote.
- **`private-model-runtime`**: `./alz models verify --production`. The summary indexes it.
- **`platform:*`**: `./alz lifecycle` on a disposable host of each platform. The summary does not ingest its report yet.

Gates the owner's release scope excludes report `OUT_OF_SCOPE`: the preview gates and the six `pillar:*` gates.

## Journal and resume

Each candidate's run lives in `<evidenceDir>/<candidate12>/` (or `<evidenceDir>/synthetic/<candidate12>/` for synthetic runs). It holds:

- `journal.jsonl`;
- `preflight.json`;
- one folder per stage, with `stage.json` and what its producers wrote there;
- `logs/`;
- `home/`, the children's private HOME.

Every runner document is mode `0600`.

The journal is append-only:

- A `start` line comes before each step and each stage, and a `finish` line after.
- A `finish` line carries the outcome, the code, a child's exit code, and the documents its producer wrote (path relative to the repository, and SHA-256).
- Every line carries the run identity: source commit, configuration digest, hardware id, label, host, and a digest of the expected account ids.

The journal refuses rather than repairs:

- A journal of another run is refused (`EVIDENCE_JOURNAL_MISMATCH`).
- A torn last line is refused, never repaired.
- A malformed document entry (an absolute path, `..`, a bad hash) is refused.

**The run lock.** `run.lock` keeps two runs out of one folder. The lock is the lifecycle runner's (`src/lifecycle/journal.ts`), not a copy:

- A lock is stale only when its process is proven gone.
- Only the run holding the exclusive takeover token may replace a stale lock, so two runs that both find a stale lock never both proceed.
- A lock that names no process (a run stopped while taking it) is refused as `EVIDENCE_LOCK_UNREADABLE`, naming the file to remove when no run is active.

**Rerunning.** The preflight runs again on every run. A stage or step that already passed is skipped.

## Writes

Every write protects itself the same way:

1. It re-checks that its folder is still a real folder at its real path, and does so again after the run lock is taken.
2. It opens the file without following a link at its name (`O_NOFOLLOW`). A whole document goes to an exclusively created temporary file, which is then renamed into place.
3. It checks every byte was written (a short write is completed or refused; review N1).
4. It checks afterward that the file it wrote is the plain, single-link file now at that path.

**Known gaps and how they are handled:**

- **Swaps.** Node cannot open a file relative to an already checked folder. A folder swapped for a link in the instant between the check and the open cannot be prevented: it is detected right after the write, and the run stops with `EVIDENCE_PATH_REFUSED`. A folder moved between the temporary file's check and the rename is reported the same way, not as a raw `ENOENT` (review N3).
- **Temporary files.** A temporary file left by a killed run (`.<name>.tmp-<pid>`) is removed by the next write into that folder once its process is gone (review N4).
- **Windows.** `O_NOFOLLOW` does not exist there. The checks after each open are what protect a write (review N5).

## What the tests prove, and what they do not

The runner's tests are SYNTHETIC: `test/evidence-*.test.ts`, with fake producers and real node children that only report what they received. They prove:

- the order of the steps;
- that no session variable reaches a child;
- that every guided child's standard input is the person's terminal, not a pipe from the runner;
- that a refusal stops the sequence;
- that resume never repeats a no-repeat step;
- that nothing runs without an enabled contract for the path or without delivered identities;
- that a synthetic summary is refused by the real admission review.

They prove nothing about a cloud. The `./alz apply` steps themselves are exercised in emulation by their own tests (`test/apply-emulated*.test.ts`). The runner's guided stages are not run end to end against an emulator, because by design no test can type a phrase into an `./alz apply` prompt through the runner. Live evidence comes only from the owner's run of this sheet.
