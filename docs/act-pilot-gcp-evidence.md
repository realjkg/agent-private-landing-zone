# GCP ACT evidence checklist: what the owner collects, and how

Status: **engineering checklist, ready before acceptance (owner decision 6481421924 on #39).** This page authorizes nothing. ACT stays DISABLED until the owner's reviewed contract has an `authorize` entry, and the repository ships no contract. Nothing on this page has run against Google Cloud. Every test it cites is SYNTHETIC or EMULATED, and none of them counts as live evidence.

The owner decision asks engineering for "an exact evidence checklist and supported collection commands before the owner runs acceptance", for one Pub/Sub topic per path. This page is that checklist for **path 5, GCP Terraform** (gate `act:gcp-terraform`). **Path 6, GCP API-native**, is a placeholder at the end and is not available yet.

Every command below is a supported `./alz` command (`./alz apply --help` lists them). The general flow, the owner-only steps and the kill switch are in [`docs/act-dev-enablement.md`](act-dev-enablement.md). This page adds what is specific to GCP.

## Path 5: GCP Terraform, DEV only

### What is being accepted

One labeled `google_pubsub_topic` in the DEV project, created by one approved apply and deleted by one approved cleanup. The topic has no subscription, no message, no schema and no customer-managed key, and the contract's region is its only storage region. The project is the committed canary [`qualification/gcp/act-dev1-canary`](../qualification/gcp/act-dev1-canary/README.md), pinned to `hashicorp/google` 8.9.0.

Owner decision 6481421924 lists the acceptance items: authorization and canary scope; qualified identities; an exact plan; human approval and execution; independent observation; verified cleanup; bound evidence; denial, replay, interruption and recovery checks. E1 to E10 below map onto them one by one.

### Owner inputs (never posted on #39 as credentials)

| Input | Where it goes |
| --- | --- |
| The DEV project id | `targets.DEV.projectId` in the contract, and the one constant in the canary's provider block (its README, "The one value written into the project") |
| The location constraint: one region | `targets.DEV.region`, and the canary's `region` variable. It becomes the topic's `messageStoragePolicy.allowedPersistenceRegions`. |
| The execution host and its workload identity federation | `bootstrap/gcp` (`docs/act-pilot-bootstrap-gcp.md`), and the sixteen `ALZ_<IDENTITY>_GOOGLE_*` variables on the host |
| The approved spend, the cleanup owner, and the retention or lifetime limit | The change record of the authorization commit. The canary topic costs nothing while it has no subscription and no message. |
| Approvers and the requester | `approvers` and `requiredApprovals.DEV` in the contract. Keys stay on each person's own machine. |

### Before bootstrap

1. Work through the **D12 checklist** in [`docs/act-pilot-bootstrap-gcp.md`](act-pilot-bootstrap-gcp.md), "Before bootstrap: the D12 checklist". Items 1 to 4 and 7, and facts GF7 to GF11, are **UNVERIFIED, MUST CHECK**. If GF7 shows that Cloud Asset needs `serviceusage.services.use`, stop and take it back to the owner decision. Never widen a grant to make a check pass.
2. Decide owner item **P5** (`enable_storage_data_access_logs`). The `SEPARATED` attestation in E3 reads Cloud Storage data-access audit logs, so without P5 nobody can see from the logs who wrote the state.
3. Run `bootstrap/gcp` once for `engine = "TERRAFORM"`, `environment = "DEV"`. Record the `terraform plan` summary and the `contract_target` and `contract_settings` outputs.

### The contract

Build it from the bootstrap outputs (`bootstrap/config.gcp.template.json`, `TERRAFORM`). Three settings are required on this path:

- `"provider": "GCP"`, `"engine": "TERRAFORM"`, and `"enabledEnvironments": ["DEV"]`: path 5 is DEV only.
- `"embedStateWrite": true`, required for every Terraform contract (owner decision 6486426552). Without it, the gcs backend takes its credentials from the apply process's environment, which is APPLY's: an earlier EMULATED run showed APPLY then holds the lock and writes the state, and the bootstrap's deny policy forbids that live. A contract without it is now refused at load (`test/apply-emulated-gcp.test.ts`). With it, every state access in the EMULATED seal, apply and cleanup was STATE_WRITE's, and a renewed token file was used without resealing.
- `targets.DEV.canary` is exactly `{ "resources": [{ "type": "google_pubsub_topic", "count": 1 }] }`.

### Evidence, step by step

Each row names the command, what the owner must see, and what gets kept. "Kept" means the encrypted record under `.runs/apply/evidence` (the vault) unless it says otherwise. Run everything on the execution host, in one channel: the terminal, or the console's Pilot apply wizard with its session token, never both for one workflow.

| # | Acceptance item | Command | The owner must see | Kept |
| --- | --- | --- | --- | --- |
| E1 | Authorization and canary scope | `./alz apply contract-check --file config/act-pilot-contract.json`, then the reviewed authorization commit (`docs/act-dev-enablement.md`, step 11), then `./alz apply status --environment DEV` | contract-check exits 0 (COMPLETE); status shows `"act": "PILOT_ENABLED"` with DEV under AUTHORIZED and its entry hash | the commit and its review; the status output in the change record |
| E2 | Identities configured, separate and aimed at the DEV project | `./alz apply preflight --environment DEV` | every item READY except qualification; no `IDENTITY_COLLAPSED`, no ambient `GOOGLE_*`, `GCLOUD_*`, `CLOUDSDK_*` or `GCE_*` variable, no `STORAGE_EMULATOR_HOST` | the preflight output in the change record |
| E3 | Qualified identities (G2) | `./alz apply prepare --environment DEV --project <CANARY_COPY>` (the canary copied outside the checkout with the DEV project id in its provider block, as its README says), then `./alz apply qualify --request <REQUEST.json> --manifest <MANIFEST.json>` | before typing `SEPARATED <STATE_WRITE email> <APPLY email>`, check the Cloud Audit Logs (service account impersonation and Cloud Storage data access) for the run: state objects touched only by STATE_WRITE, Pub/Sub only by APPLY and DISCOVERY, and no bucket access by APPLY or DISCOVERY | the qualification evidence (encrypted, `.runs/apply/qualification`) |
| E4 | An exact plan | `./alz apply seal --request <REQUEST.json> --manifest <MANIFEST.json> --requester <ID> --key <REQUESTER_KEY.pem>` | the review bundle lists exactly **1 create**, `google_pubsub_topic.act_dev1`; the source commit is the candidate's | the sealed plan and review bundle |
| E5 | Human approval and execution | `./alz apply approve --bundle <REVIEW_BUNDLE.json> --key <APPROVER_KEY.pem> --approver <ID>` (each approver on their own machine), then `./alz apply apply --request <REQUEST.json> --manifest <MANIFEST.json> --sealed <SEALED_PLAN> --approval <APPROVAL.json>`, then `./alz apply status --sealed <SEALED_PLAN>` | outcome `SUCCEEDED`; the evidence names the source commit, the contract hash and the target hash | the apply evidence and the blueprint record |
| E6 | Live record | `./alz apply record-live --sealed <SEALED_PLAN>` (type `LIVE DEV <12 chars>`) | the record names `cloud: "GCP"`, `engine: "TERRAFORM"` and the same commit, contract and target hashes | `config/acceptance/evidence/<cloud>-<engine>-execute-dev-<artifact>.json`, committed |
| E7 | Independent observation | `./alz apply observe --sealed <SEALED_PLAN>` | verdict `VERIFIED`, verifier `GCP_REST`, inventory `COMPLETE`, and the topic `VERIFIED`, which includes that its storage policy is exactly the contract's region (D11). A topic stored elsewhere is `DIFFERENT_FROM_DESIRED` and the verdict `FAILED` | the observation record |
| E8 | Verified cleanup | `./alz apply propose-cleanup --sealed <SEALED_PLAN> --requester <ID> --key <REQUESTER_KEY.pem>`; `./alz apply approve --bundle <PROPOSAL.json> --key <APPROVER_KEY.pem> --approver <ID>`; `./alz apply cleanup --proposal <PROPOSAL.json> --request <REQUEST.json> --manifest <MANIFEST.json> --sealed <SEALED_PLAN> --approval <CLEANUP_APPROVAL.json>`; `./alz apply verify-cleanup --proposal <PROPOSAL.json>` | the proposal deletes exactly the topic and protects the state bucket (`PROTECTED_BACKEND`); after cleanup the topic is `CONFIRMED_DELETED` with basis `GCP_REST_ABSENT` | the proposal, cleanup evidence and leftovers record |
| E9 | Bound evidence | `./alz apply report --sealed <SEALED_PLAN> --proposal <PROPOSAL.json>`, then `./alz qualify admission --manifest <evidence-index-file>` | the report ties E4 to E8 to one artifact, contract, target and source commit; admission reports the gate's evidence as live | the report and the admission output |
| E10 | Denial, replay, interruption and recovery | see below | each refusal code, and that nothing changed in the project | the outputs in the change record |

**E10, the checks that change nothing.** Each one is refused before anything runs, so it costs nothing:
- **Kill switch:** create the contract's `killSwitchPath` file, run `./alz apply apply ...` for a fresh sealed plan, and expect `KILL_SWITCH_ACTIVE`. The owner removes the file by hand.
- **Replay:** run `./alz apply apply ...` again for the plan E5 applied, with a fresh approval, and expect `ARTIFACT_ALREADY_APPLIED`. Reusing an approval is refused too.
- **Scope:** run `./alz apply preflight --environment QA` and expect it not to be READY. Path 5 is DEV only, and the driver refuses any QA request against a DEV-only contract (`TARGET_NOT_IN_CONTRACT`).
- **Interruption and recovery (G5):** only if a real run is interrupted. Record it with `./alz apply record-recovery --sealed <INTERRUPTED_SEALED_PLAN> --resumed <RESUMED_SEALED_PLAN> --target-hardware-id <HOST>`, never by hand.

### Timing: Cloud Asset indexing

The observation's unit sweep reads Cloud Asset Inventory, which indexes new resources with a delay (minutes; GF5, unverified). Right after an apply, the sweep may not list the new topic yet. That is not a failure: a resource the state names that the sweep does not yet list is not a stray. A listing that fails or stops part-way, though, makes the verdict `INCONCLUSIVE`. Rerun `./alz apply observe --sealed <SEALED_PLAN>` after a few minutes. Never record `PASS` by hand.

### Manual resolution (review note N-3 of the API record)

If the governed cleanup cannot run and a person deletes the topic by hand, a rerun of `./alz apply observe --sealed <SEALED_PLAN>` reports the topic `MISSING` and the observation `FAILED`. **That is the expected result for an absent topic**, not a new fault (EMULATED: `test/apply-emulated-gcp.test.ts`, "a hand-deleted topic observes as FAILED"). Record three things: the manual deletion, who made it, and the Cloud Audit Logs entry for the `DELETE`. A manual deletion is not a product cleanup. E8 stays open until a governed cleanup is recorded, or the owner records the exception.

### What never counts as live evidence

All of these are SYNTHETIC or EMULATED, and are listed so nobody mistakes them for acceptance:
- `test/apply-gcp-admission.test.ts`, `test/apply-gcp.test.ts`, `test/observe-gcp.test.ts`: fake Terraform, a scripted Google.
- `test/apply-emulated-gcp.test.ts`: the real driver, the real Terraform and the real google 8.9.0 provider, against a loopback emulator of Google's endpoints. It proves the product's flow, the judge on the real plan shape and the state separation under `embedStateWrite`. It does not prove IAM, scopes or anything else about Google.
- `bootstrap/gcp`'s `terraform test`: a mocked provider.

## Path 6: GCP API-native (placeholder, NOT YET AVAILABLE)

There is no checklist for path 6 yet, and the owner cannot collect its evidence. The engine is not in `SPECS`, and the gate `act:gcp-gcp_api` does not exist. Lanes G2 and INT-2 add them, after the D5 interface change (`docs/act-pilot-gcp-api-driver.md`, section 4). The design decisions that will shape it:
- two identities, DISCOVERY and APPLY (D12);
- the topic prefix and a run-unique name drawn at seal (D4, D10);
- the storage policy sealed and read back (D11);
- exact-resource cleanup (D16).

Engineering fills in this section before the owner runs path 6 acceptance. Until then, nothing here applies to path 6.
