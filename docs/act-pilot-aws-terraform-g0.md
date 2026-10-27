# G0 package: AWS Terraform pilot, and the owner-input kit

Status: G0 is a documentation gate ("Docs only; no heavyweight run", `docs/act-pilot-plan.md`). This page writes down the three things G0 asks for, for the first live ACT path the owner chose on 2026-10-27 (issue #39, comment 6431744115, decision 4: "First live ACT path: AWS Terraform"): the provider and engine, the approver roles, and the rollback and partial-failure behavior as the driver implements it. It then gives the owner a kit: every input only the owner can supply, mapped to the contract field or the place that checks it, and one offline command that tells the owner what a draft contract still lacks.

Nothing on this page enables ACT. The repository ships no pilot contract (the old hash pin is removed; the contract's `authorize` entry is the switch), the product's ACT default stays DISABLED, agents never hold approver keys and never initiate an apply (`AGENTS.md`, the ACT amendment). Enabling the pilot is, and stays, the owner's reviewed commit of the contract with its `authorize` entry, followed by an owner-supervised DEV apply (`docs/act-pilot-apply.md`, "The contract is the authorization").

People are never named here. Where a person is needed the text uses a role and the placeholder `<name>`.

## G0 decisions

### Provider and engine

| Decision | Value | Where it is bound |
| --- | --- | --- |
| Provider | `AWS` with the S3 state backend | the contract's `provider`, validated against `src/apply/providers/aws.ts` (`docs/act-pilot-apply.md`, "AWS") |
| Engine | `TERRAFORM` | the contract's `engine`, validated against `src/apply/engines/terraform.ts` with its pinned argument lists in `src/apply/terraform.ts` |
| Pilot scope | the DEV-only pilot (`"enabledEnvironments": ["DEV"]`, `docs/act-dev-1.md`), one additive change, in one DEV member account | the contract (a DEV-only contract carries exactly `targets.DEV` and `requiredApprovals.DEV`, `src/apply/contract.ts`); the sealed plan's change list, which the approver signs |
| Identities | four distinct IAM roles assumed through web identity, no static keys: DISCOVERY, STATE, STATE_WRITE, APPLY | `ALZ_<IDENTITY>_AWS_ROLE_ARN`, `ALZ_<IDENTITY>_AWS_WEB_IDENTITY_TOKEN_FILE`, `ALZ_<IDENTITY>_AWS_REGION` on the execution host, checked by `./alz apply preflight` and attested by `./alz apply qualify` |
| State | one versioned S3 bucket per environment, native locking (`use_lockfile = true`, no DynamoDB table) | the contract's `backend` (`<bucket>/<key>`), the STATE_WRITE partial backend configuration at `init` |
| Channel | the terminal or the console wizard, chosen when the workflow starts and sealed into the plan, never mixed | `docs/act-pilot-apply.md`, "Channels" |

The contract shape for this decision is `config/act-pilot-contract.aws-dev.example.json`. It is deliberately invalid (placeholders and fake identifiers) so it can never enable ACT; the owner's copy lives at `config/act-pilot-contract.json`, which is not committed until the owner's reviewed authorization commit.

### Approver roles

Approvals are Ed25519 signatures by keys on the contract's allowlist, never a typed name (`docs/act-pilot-plan.md`, authority item 3; `src/apply/approval.ts`). The roles below are what the contract's `approvers` list and `requiredApprovals` encode. The owner assigns people to roles; this page assigns none.

| Role | Holds | In the contract | Rules the driver enforces |
| --- | --- | --- | --- |
| **Pilot owner** `<name>` | the decision to enable the pilot; the kill switch (`killSwitchPath`); the reviewed authorization commit (`enabled` and `authorize`); the `policyVersion` | not an approver by right: the owner may also be an approver if listed | the authorization is a reviewed commit of the contract (nothing in the product writes it); the kill switch file is removed by the owner, never by code |
| **Operator** `<name>` | the execution host and its four identity variables; runs `preflight`, `prepare`, `seal`, `apply`, `observe`, `propose-cleanup`, `cleanup` | none | a person at a terminal (or in the wizard with the session token). The operator who seals is the **requester**: an allowlisted id whose own key signs the sealed request (`--requester ID --key KEY.pem`); the id is bound into the artifact hash every approver signs. In PROD the requester cannot approve (`APPROVER_IS_REQUESTER`, `src/apply/approval.ts`); in DEV and QA the same person may request and approve |
| **DEV approver** `<name>` | an Ed25519 key pair; signs the DEV plan and the DEV cleanup proposal | `approvers[]` with `environments` including `DEV`; `requiredApprovals.DEV` is 1 | the approval binds the artifact hash, environment, target, expiry and a one-time nonce; a replayed, expired or mis-bound approval is refused |
| **QA approver** `<name>` (chain only) | signs the QA plan | `approvers[]` with `QA`; `requiredApprovals.QA` is 1 | QA needs a successful DEV apply of the same release identity (`requirePromotionEvidence`) |
| **Production approver 1** `<name>` and **Production approver 2** `<name>` (chain only) | two separate key pairs on two separate machines | two `approvers[]` entries with `PROD`; `requiredApprovals.PROD` is at least 2 | three distinct people: two distinct verified approvals (`requiredApprovals.PROD`), neither from the requester's key nor from any key under the requester's id (`APPROVER_IS_REQUESTER`, refused by `approve` before the phrase and by the driver before anything is consumed); a GitHub required-reviewer list does not satisfy this on its own |
| **Qualifier** `<name>` | runs `./alz apply qualify` on the execution host against the real Terraform and attests, from CloudTrail, `SEPARATED <STATE_WRITE role ARN> <APPLY role ARN>` | none | without that encrypted evidence every seal and apply is `ENGINE_NOT_QUALIFIED` (`verifyApplyQualification`, `src/apply/contract.ts`) |
| **Cleanup owner** `<name>` | authorizes the live cleanup of what the pilot created, separately from the apply; reviews by hand after `PARTIAL_REQUIRES_REVIEW` or `KILLED` | none (cleanup approvals come from the same allowlist under the cleanup signature domain) | a cleanup proposal is built from the run's own records and executes once; protected objects are never deleted (`docs/act-pilot-plan.md`, "Cleanup of pilot-created resources") |

For the DEV-only pilot the minimum is three people: a pilot owner, an operator and a DEV approver, with the owner free to hold more than one role: in DEV the requester may approve their own change (the code allows it; production refuses it).

### Rollback and partial-failure behavior

This is what `src/apply/driver.ts` does, as `docs/act-pilot-apply.md` ("When an apply fails", "Kill switch") documents it. There is no automatic rollback: Terraform has none, and the driver adds none. Every outcome closes the artifact and a retry is a new preview with new approvals.

**Before the engine runs, nothing is spent.** The gates (contract and pin, kill switch, a person, the contract's target, the sealed plan and its bundle, the approvals, qualification, the identities) refuse with exit 2 (`BLOCKED`) and consume nothing; a stop signal before the engine started, or an engine that could not start, is `APPLY_FAILED` with exit 1 and consumes nothing either. The approvals are consumed only after every gate passed and the artifact was reserved in the ledger (`reserveArtifact`, an exclusive create in state `RESERVED`, `src/apply/ledger.ts`). If the switch appears or the engine cannot start after that point, the run ends `KILL_SWITCH_AFTER_APPROVALS` or `APPROVALS_SPENT` (exit 3): the approvals are gone, nothing ran, and the sealed plan is given back for new approvals.

**Once `terraform apply` has started, the recorded outcome is one of `SUCCEEDED`, `FAILED_NO_CHANGE`, `PARTIAL_REQUIRES_REVIEW` and `KILLED`** (`ApplyOutcome`, `src/apply/types.ts`; a stale plan is reported as the refusal `PLAN_STALE` with outcome `FAILED_NO_CHANGE`), decided by `classifyApply` (`src/apply/terraform.ts`) from the engine's exit code, whether a stop was requested, the state serial and the first `Error:` diagnostic. `SUCCEEDED` ends with exit 0; the other outcomes end with exit 3 (`SPENT`). Whatever the outcome, the sealed plan and its approvals are used up and the evidence replaces the reservation.

| Outcome | When | What the owner does |
| --- | --- | --- |
| `SUCCEEDED` | the engine exited 0 (that is the whole test; the driver checks no further state agreement) | `observe`, then the cleanup half when the pilot is done |
| `FAILED_NO_CHANGE` | only a state-lock refusal (`Error acquiring the state lock`) with the state serial unmoved | fix the cause, seal a new preview, collect new approvals |
| `PLAN_STALE` | `Saved plan is stale` with the serial unmoved; nothing applied | seal a new preview |
| `PARTIAL_REQUIRES_REVIEW` | any other non-zero exit once the apply began, or a moved serial (Terraform exits 1 for every apply error, so a refusal cannot be told from a failure halfway) | **do not retry.** A person reviews state and resources by hand, then seals a new preview |
| `KILLED` | the kill switch appeared while the apply ran, the 30 minute limit passed, or a stop signal arrived: SIGINT to Terraform, then SIGKILL to its process group after 60 seconds | **do not retry.** Review state, the lock and the resources by hand; the state lease may still be held |

**What the ledger holds.** The evidence replaces the reservation whatever the outcome (encrypted, identifiers and hashes only: who approved, what artifact, what ran, the outcome, the redacted output). If the process dies after the engine started, the entry stays `RESERVED`: `status` and every later apply report the artifact as already applied, and nothing ever makes it applicable again. After any non-success outcome the driver keeps `errored.tfstate` and `crash.log` from the engine's work directory in the encrypted evidence vault (purpose `apply-recovery`), and the evidence carries their count and hash. The stale-scratch sweep is skipped while a reservation or a recovery file exists, so a crashed run's only record is not deleted.

**Recovery is a person's review, then a new plan.** The owner reads `./alz apply status --sealed SEALED_PLAN`, the state (as an administrator, outside the pilot's identities), the resources and CloudTrail, and decides. A stuck lock is released by hand after that review (`docs/act-pilot-bootstrap.md`, "State lock stuck"); the pilot never uses `-lock=false` or force-unlock. Reversal, when wanted, is the governed cleanup: `observe`, `propose-cleanup`, `approve` under the cleanup domain, `cleanup` limited to exactly the approved addresses, `verify-cleanup`. A partial apply yields no proposal (`propose-cleanup` fails closed), so after `PARTIAL_REQUIRES_REVIEW` the person's review comes first, and what the review decides to remove is a new preview of its own.

**G5 evidence.** A recovery demonstrated on the real account is recorded by `./alz apply record-recovery --sealed INTERRUPTED_SEALED_PLAN --resumed RESUMED_SEALED_PLAN --target-hardware-id HOST` (`docs/act-pilot-apply.md`, "Recording an interrupted apply's recovery"): the interrupted run must have ended `PARTIAL_REQUIRES_REVIEW` or `KILLED` in the ledger, the run that followed must be another sealed artifact that `SUCCEEDED` under approvals issued after the interruption, and every field is derived from the ledger. No synthetic recovery record exists to relabel.

## Gap assessment, G0 to G5

What exists in the product today for AWS Terraform, what engineering still owes, and what only the owner can provide. Evidence from a fake engine is synthetic and never counts as live (`AGENTS.md`).

| Gate | Exists (cite) | Engineering gap | Owner item |
| --- | --- | --- | --- |
| G0 | this page; the provider and engine specs; `config/act-pilot-contract.aws-dev.example.json`; `docs/act-dev-1.md` D0 to D8 | none after this page merges | assign the roles above to people; choose the execution host; decide the pilot scope (one additive change) and the cleanup owner |
| G1 | denial paths tested with a fake engine: no apply without a matching approved preview and none with a changed artifact (`test/apply-cli.test.ts`, `test/apply-seal.test.ts`, `test/apply-approval.test.ts`), no agent-initiated apply and no console job (`test/apply-boundary.test.ts`, `test/operations-parity.test.ts`), no operator-credential inheritance and no identity collapse (`test/apply-identities.test.ts`, `test/apply-aws.test.ts`), no unlocked state and no `-lock=false` (`test/teardown-driver-denials.test.ts`), the ledger (`test/apply-ledger.test.ts`) | none known | none |
| G1b | the Azure row's emulated simulation (`docs/act-pilot-simulation.md`, `test/apply-emulated.test.ts`); the AWS row has no emulated simulation yet (owner decision 4) | lane 3: an opt-in run of the real Terraform binary against a local S3-compatible state backend, under the AWS spec. The plan enables ACT for the DEV run only after it passes (`docs/act-pilot-plan.md`, G1b) | none for the simulation; the reviewed authorization commit comes after it |
| G2 | `./alz apply qualify` for Terraform (`docs/act-pilot-apply.md`, "Qualifying against a real engine"); `./alz apply preflight`; `./alz apply prepare`; the AWS bootstrap (`bootstrap/aws`, `docs/act-pilot-bootstrap.md`); the DEV-only contract; `./alz apply record-live` | none known in the product; the open real-AWS questions in `docs/act-pilot-apply.md` ("Open item that blocks live apply") are answered by the run, not by code | the DEV member account, the bootstrap (OIDC provider, four roles, versioned bucket, policies, budget), four token files on the execution host, a person to qualify and attest from CloudTrail, one supervised DEV apply recorded with `record-live` |
| G3 | release admission reads the same pin (`src/qualification/release-admission.ts`); `config/release/status.json` carries `act:aws-terraform` BLOCKED with synthetic evidence | none for the DEV pilot | the authorization commit; `./alz qualify admission` after the live record |
| G4 | the promotion chain in `requirePromotionEvidence` and two-approver PROD quorum in the contract validator, fake engine | none for the DEV-only pilot; the chain needs a three-account contract, which the DEV-only pilot does not use | out of the DEV-only pilot's scope; later, the QA and PROD accounts, buckets, roles and the second production approver |
| G5 | the outcomes and ledger above; `./alz apply record-recovery` | none known | demonstrate a recovery on the real account, or show the failure handling held, and record it |

## The owner-input kit

### Check a draft offline

```
./alz apply contract-check --file config/act-pilot-contract.json
```

It reads that one file and the shipped `config/act-pilot-contract*.example.json` files (to recognize copied example values) and nothing else: no pin, no credential, no identity variable, no cloud, no network. It prints each owner input by its contract field with one status: `PRESENT` (a value is there and nothing marks it as not an input); `MISSING` (absent or empty); `PLACEHOLDER` (still a `REPLACE-WITH` value, or the example's `EXAMPLE` marker field); `EXAMPLE` (the examples' fake account ids, a repeated single digit, or their `examplefake` state buckets: values that can never be an owner input); `INVALID` (the contract validator's own refusal, in its own words; `src/apply/contract.ts` is the one definition of a valid contract). A `PRESENT` input can also carry a `NOTICE`: its region, workspace or kill switch path equals a shipped example's value (`us-east-1`, `us-east-2`, `default`, `.runs/apply/KILL`), which are legitimate choices, so the notice asks a person to confirm each default is intended rather than left over from the copy; a notice never counts against COMPLETE. The kit is stricter than the validator in exactly three ways: it requires enough approvers allowed for PROD to reach `requiredApprovals.PROD` (the validator checks the number, not the list); it refuses values that are not inputs at all (the placeholders, the fake account ids, the `examplefake` buckets, the example keys); and it requires `enabled` to be written as a boolean, as the loader does. Then the inputs that are not contract fields and where each is checked instead. Exit 0 means complete, exit 2 means inputs remain, and neither enables anything: the command never writes the pin and never flips `enabled`. A complete draft is information for the owner, not approval; seal and apply run their own gates. The same shape check is what `./alz apply preflight` reports as its first item, but preflight also needs the identities and the tool folders; this check needs only the file, so the owner can run it before the bootstrap exists.

### Every owner-supplied item, mapped

Identifiers and public keys only. No private key, token, password or secret value is ever written into the contract or shown to this product.

| Owner item | Contract field or check | Notes |
| --- | --- | --- |
| The reviewed `policyVersion` | `policyVersion` | `prepare` copies it into every request and manifest; the pin accepts its absence, `prepare` then stops with an owner prerequisite |
| The DEV 12 digit account id (and QA, PROD for the chain) | `targets.<ENV>.accountId` | three environments differ pairwise in account and backend |
| The region | `targets.<ENV>.region` | every identity's `ALZ_<IDENTITY>_AWS_REGION` must equal it; a region, workspace or kill switch path that equals an example's value stays PRESENT with a NOTICE asking a person to confirm the default is intended |
| The versioned S3 state bucket and the state object key | `targets.<ENV>.backend` as `<bucket>/<key>` | versioning on; the lock file is an object next to the state object |
| The workspace | `targets.<ENV>.workspace` | `default` unless the owner decides otherwise |
| The approvals each environment needs | `requiredApprovals.<ENV>` | DEV and QA at least 1; PROD at least 2 |
| The approval lifetime | `maxApprovalAgeMinutes` | 1 to 1440 |
| Each approver: id, Ed25519 public key (PEM), environments | `approvers[]` | ids and keys unique; the private key stays with the approver |
| The second production approver | a second `approvers[]` entry with `PROD` | checked by the kit; the chain only. At apply, neither PROD approval may come from the requester's key or id |
| The kill switch path | `killSwitchPath` | the owner creates and removes the file; a switch that cannot be read counts as on |
| The IAM OIDC identity provider per account | not a field | `bootstrap/aws`; its trust is what lets each identity's token assume its role |
| The four web-identity roles per account | `ALZ_<IDENTITY>_AWS_ROLE_ARN` on the execution host | each ARN's account must be the contract's; `preflight` checks, `qualify` attests STATE_WRITE and APPLY |
| The token files on the execution host | `ALZ_<IDENTITY>_AWS_WEB_IDENTITY_TOKEN_FILE` | absolute paths, four distinct files; never the operator's own `AWS_WEB_IDENTITY_TOKEN_FILE` |
| Least-privilege scope, budget, retention, tags | the owner's bootstrap and policy (`docs/act-pilot-bootstrap.md`, `docs/act-dev-1.md`) | the deletion-unit tags (`alz-managed-by`, `alz-unit`, `alz-build`) go in the project's `default_tags`; `seal` refuses a missing or foreign tag |
| The execution host | this page (G0) and `--target-hardware-id` on the live records | the host where the four token files exist and `./alz apply` runs |
| The pilot scope | this page (G0); the sealed plan's change list | one additive change the approver signs for |
| The cleanup owner | this page (G0) | authorizes the live cleanup separately |
| A person to qualify | `./alz apply qualify` and the `SEPARATED` attestation | from CloudTrail: state access by STATE_WRITE, provider access by APPLY, none by APPLY on state |

### The owner's checklist to enable ACT on AWS Terraform DEV

In order; each step is the owner's or a person the owner names. No agent performs any of them.

1. Assign the roles on this page to people; choose the execution host; write down the one change and the cleanup owner.
2. Create or verify the DEV member account (`docs/act-dev-1.md`, D1 and D2: account, credits or authorized spend, budget alerts).
3. Run the AWS bootstrap with a separately held administrative identity (`docs/act-pilot-bootstrap.md`, Step 2): the OIDC provider, the four roles with exact-subject trust, the versioned bucket with its policy. Place the four token files on the execution host.
4. Copy `config/act-pilot-contract.aws-dev.example.json` to `config/act-pilot-contract.json`, fill in the values from the table above with `enabled: false`, and run `./alz apply contract-check --file config/act-pilot-contract.json` until it reports COMPLETE; confirm each NOTICE (a region, workspace or kill switch path that still equals the example's default) is the intended choice.
5. Set the twelve `ALZ_<IDENTITY>_AWS_*` variables on the execution host and run `./alz apply preflight --environment DEV`: every item but qualification READY.
6. Wait for G1b: the AWS emulated simulation (lane 3) passes. This is engineering's, not the owner's, and the plan puts it before the authorization commit (`docs/act-pilot-plan.md`, G1b).
7. Review the values, set `enabled: true` and `"authorize": { "DEV": ["APPLY", "CLEANUP"] }`, and commit the contract in one reviewed change. This is the step that enables the pilot, and it is the owner's alone.
8. Have the qualifier run `./alz apply qualify` against the real Terraform on DEV and attest from CloudTrail.
9. Supervise one DEV apply (`prepare`, `seal`, `approve`, `apply`) in one channel, watching CloudTrail, and record it with `./alz apply record-live --sealed SEALED_PLAN`.
10. Separately authorize the live cleanup (`observe`, `propose-cleanup`, `approve`, `cleanup`, `verify-cleanup`, `report`).

The requester-signing rule (the requester signs the sealed request; production needs three distinct people) is enforced in code (`src/apply/approval.ts`, `src/apply/seal.ts`, `src/apply/driver.ts`; `test/apply-requester.test.ts`).
