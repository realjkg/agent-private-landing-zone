# Ollama and human-in-the-loop pilot: live steps and evidence

This runbook covers the first live LZA/AFT pilot on the owner's own AWS account. It runs from the owner's Mac. Every live step
has three parts: who does it, the command, and the evidence file it leaves. The one-flow status (`src/flow/one-flow.ts`,
path `lza-aft`) reads those files and names the next step.

Agents prepare, check and explain. A person does every step marked **You** or **Owner**. No agent holds a cloud credential,
merges a pipeline change, or closes an account.

## 0. Before you start

| Need | Why |
|---|---|
| A clean, committed checkout at the candidate commit | Every evidence file is bound to the source commit. |
| Ollama on loopback with `qwen3:1.7b`, `qwen3:4b`, `mistral-nemo:12b` | The required local models (`src/config.ts`). |
| AWS IAM Identity Center (SSO) or role assumption into a read-only DISCOVERY role | The runner refuses static keys (`STATIC_SECRET_IN_ENVIRONMENT`). |
| A spend ceiling for the account, set by the owner in AWS Budgets | Control Tower, LZA and AFT run billable pipelines. |
| A teardown decision | RETAIN (default) or removal through `aws-aft-lza-removal`. |

## 1. Set up this computer (You)

```sh
./alz bootstrap
./alz doctor
```

Evidence: `dist/.alz-build-complete` names the checkout's commit. The one-flow `setup` step reads it.

## 2. Private models (You, then Owner)

```sh
ollama pull qwen3:1.7b && ollama pull qwen3:4b && ollama pull mistral-nemo:12b
./alz models list
```

**Owner: record the three digests.** Read each manifest digest from
`https://registry.ollama.ai/v2/library/<name>/manifests/<tag>` (header `Docker-Content-Digest`), check that it equals the
installed copy's digest in `ollama list`, and commit it to `config/tool-pins.json` (`isolatedOllama.modelDigests`). A value
copied from `ollama list` alone is not a pin (`docs/model-qualification.md`). Then:

```sh
./alz models verify
./alz matrix --live-models --scenario cdk-aws-brownfield
./alz matrix --live-models --scenario terraform-aws-brownfield
```

Evidence: `.runs/qualification/private-agent-matrix/matrix-<id>.json` with `mode: LIVE_PRIVATE_MODELS`, the source commit,
and each model's installed digest. The one-flow `models` step is DONE only when both scenarios passed live at this commit.
The live matrix uses local inference with fixture estates. It is not AWS evidence.

## 3. Offline rehearsal (You)

```sh
./alz matrix --offline-fixture --scenario cdk-aws-brownfield
./alz matrix --offline-fixture --scenario terraform-aws-brownfield
```

Evidence: the same matrix folder, `mode: OFFLINE_FIXTURE`. The one-flow `rehearse` step needs both at this commit.

## 4. Classify the account: greenfield or brownfield (You)

Sign in, then run read-only discovery:

```sh
aws sso login --profile <discovery-profile>
AWS_PROFILE=<discovery-profile> ./alz inspect aws
```

Discovery reports BROWNFIELD when it observes Organizations, Control Tower, SCPs, AFT, existing IaC, Config or CloudTrail
(`src/discovery/classify.ts`). Live discovery never reports GREENFIELD by itself: an account with none of those signals is
UNKNOWN, and the owner confirms greenfield.

**Greenfield.** Prepare the account for LZA:

1. Owner: set up the Control Tower landing zone in the home Region, then deploy LZA and AFT (several hours, billable).
2. Owner: in the LZA configuration repository, define the OUs in `organization-config.yaml` and the workload account in
   `accounts-config.yaml`. LZA creates the account from that file, and AFT does not.
3. Owner: fill in `config/aft-lza-card.json` from `config/aft-lza-card.example.json` and commit it. Run the pinned LZA
   validator against the configuration first; the card needs its evidence digest.

**Brownfield.** Discover first, change nothing:

1. Keep the `./alz inspect aws` output as the inventory.
2. Agents compare the observed estate with the LZA baseline (`docs/aws-lza-intake.md`, `docs/brownfield-policy-reuse.md`)
   and draft recommendations: what to reuse, what to change, what to retire. Each recommendation names its owner and the data
   it touches.
3. Owner: decide per item. Where data must move, the plan preserves it in place and moves it into the new landing zone's
   accounts; deletion happens only after the copy is verified. A full migration or cutover is outside this pilot.

## 5. Describe the run (Owner)

```sh
./alz evidence init
```

Then name the card in `config/evidence-runner.json` (`aws.aftLzaCard`) and the candidate commit. Evidence: the one-flow
`describe` step reads this file.

## 6. Create, register and verify the account (You at the terminal)

```sh
./alz evidence run --stage aws-aft-lza
```

The stage reads the pipelines under the DISCOVERY identity and stops at each write for you:

| Stage asks | You do | The stage then checks |
|---|---|---|
| Merge the LZA change | Merge it in the LZA repository, type the merge commit | The LZA pipeline run for that commit, then the account by email |
| Merge the AFT request | Merge it in the AFT request repository, type the merge commit | The request pipeline, the account's customizations pipeline, the controls in every Region |

Rerun the same command after each pipeline finishes. It resumes from the journal and never offers a write twice. Evidence:
`.runs/evidence/<commit>/journal.jsonl` and `aws-aft-lza/decision.json` (`LIVE_READ_ONLY`). The one-flow `change` step is
DONE (`VERIFIED`) only on a live PASS.

## 7. Watch for drift (You)

```sh
./alz qualify aft-lza-drift --card config/aft-lza-card.json --output .runs/qualification/aft-lza-drift.json
```

The one-flow `watch` step accepts a report from the last 8 hours.

## 8. Remove, only if the owner decides to (You at the terminal)

```sh
./alz evidence run --stage aws-aft-lza-removal
```

AFT first, then Control Tower unmanage, then LZA moves the account under the ignored OU (`docs/aft-lza-act-workflow.md`,
"Removal"). Closing the account is the owner's decision and happens outside the runner.

## What counts as live evidence

| Evidence | Live? |
|---|---|
| Matrix with `mode: LIVE_PRIVATE_MODELS` | Local model inference only |
| Matrix with `mode: OFFLINE_FIXTURE` | No |
| Journal lines labelled `LIVE` for `aws-aft-lza` / `aws-aft-lza-removal` | Yes, read-only observation of the owner's account |
| Anything labelled `SYNTHETIC` | No |
