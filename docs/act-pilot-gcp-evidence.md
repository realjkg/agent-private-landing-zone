# GCP ACT evidence checklist: what the owner collects, and how

Status: **engineering checklist, ready before acceptance (owner decision 6481421924 on #39).** This page authorizes nothing. ACT stays DISABLED until the owner's reviewed contract has an `authorize` entry, and the repository ships no contract. Nothing on this page has run against Google Cloud. Every test it cites is SYNTHETIC or EMULATED, and none of them counts as live evidence.

The owner decision asks engineering for "an exact evidence checklist and supported collection commands before the owner runs acceptance", for one Pub/Sub topic per path. This page is that checklist for **path 5, GCP Terraform** (gate `act:gcp-terraform`) and **path 6, GCP API-native** (gate `act:gcp-gcp_api`, admitted for DEV only by INT-2).

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
| E3 | Qualified identities (G2) | `./alz apply prepare --environment DEV --project <CANARY_COPY>` (the canary copied outside the checkout with the DEV project id in its provider block, as its README says), then `./alz apply qualify --request <REQUEST.json> --manifest <MANIFEST.json>` | before typing `SEPARATED <STATE_WRITE email> <APPLY email>`, check the Cloud Audit Logs (service account impersonation and Cloud Storage data access) for the run: state objects touched only by STATE_WRITE or STATE, and no bucket access by APPLY or DISCOVERY. Qualify runs nothing as APPLY, so APPLY's Pub/Sub access is checked at the first supervised DEV apply | the qualification evidence (encrypted, `.runs/apply/qualification`) |
| E4 | An exact plan | `./alz apply seal --request <REQUEST.json> --manifest <MANIFEST.json> --requester <ID> --key <REQUESTER_KEY.pem>` | the review bundle lists exactly **1 create**, `google_pubsub_topic.act_dev1`; the source commit is the candidate's | the sealed plan and review bundle |
| E5 | Human approval and execution | `./alz apply approve --bundle <REVIEW_BUNDLE.json> --key <APPROVER_KEY.pem> --approver <ID>` (each approver on their own machine), then `./alz apply apply --request <APPLY_REQUEST.json> --manifest <MANIFEST.json> --sealed <SEALED_PLAN> --approval <APPROVAL.json>`, then `./alz apply status --sealed <SEALED_PLAN>` | outcome `SUCCEEDED`; the evidence names the source commit, the contract hash and the target hash | the apply evidence and the blueprint record |
| E6 | Live record | `./alz apply record-live --sealed <SEALED_PLAN>` (type `LIVE DEV <12 chars>`) | the record names `cloud: "GCP"`, `engine: "TERRAFORM"` and the same commit, contract and target hashes | `config/acceptance/evidence/<cloud>-<engine>-execute-dev-<artifact>.json`, committed |
| E7 | Independent observation | `./alz apply observe --sealed <SEALED_PLAN>` | verdict `VERIFIED`, verifier `GCP_REST`, inventory `COMPLETE` (which now requires the sweep to list the run's own topic: see "Timing and the sweep's positive control"; a query that never matches keeps this `INCONCLUSIVE` indefinitely, GF3's fail-closed signal), `sweepControlPassedAt` set in the observation record, and the topic `VERIFIED`, which includes that its storage policy is exactly the contract's region (D11). A topic stored elsewhere is `DIFFERENT_FROM_DESIRED` and the verdict `FAILED` | the observation record |
| E8 | Verified cleanup | `./alz apply propose-cleanup --sealed <SEALED_PLAN> --requester <ID> --key <REQUESTER_KEY.pem>`; `./alz apply approve --bundle <PROPOSAL.json> --key <APPROVER_KEY.pem> --approver <ID>`; `./alz apply cleanup --proposal <PROPOSAL.json> --request <APPLY_REQUEST.json> --manifest <MANIFEST.json> --sealed <SEALED_PLAN> --approval <CLEANUP_APPROVAL.json>`; `./alz apply verify-cleanup --proposal <PROPOSAL.json>` | the proposal deletes exactly the topic and protects the state bucket (`PROTECTED_BACKEND`); after cleanup the topic is `CONFIRMED_DELETED` with basis `GCP_REST_ABSENT`, and the leftovers record says `"strays": "PROVEN"` with the disposition `COMPLETE` (an `UNPROVEN` record does not count: "Timing and the sweep's positive control") | the proposal, cleanup evidence and leftovers record |
| E9 | Bound evidence | `./alz apply report --sealed <SEALED_PLAN> --proposal <PROPOSAL.json>`, then `./alz qualify admission --manifest <evidence-index-file>` | the report ties E4 to E8 to one artifact, contract, target and source commit; admission reports the gate's evidence as live | the report and the admission output |
| E10 | Denial, replay, interruption and recovery | see below | each refusal code, and that nothing changed in the project | the outputs in the change record |

**E10, the checks that change nothing.** Each one is refused before anything runs, so it costs nothing:
- **Kill switch:** create the contract's `killSwitchPath` file, run `./alz apply apply ...` for a fresh sealed plan, and expect `KILL_SWITCH_ACTIVE`. The owner removes the file by hand.
- **Replay:** run `./alz apply apply ...` again for the plan E5 applied, with a fresh approval, and expect `ARTIFACT_ALREADY_APPLIED`. Reusing an approval is refused too.
- **Scope:** run `./alz apply preflight --environment QA` and expect it not to be READY. Path 5 is DEV only, and the driver refuses any QA request against a DEV-only contract (`TARGET_NOT_IN_CONTRACT`).
- **Interruption and recovery (G5):** only if a real run is interrupted. Record it with `./alz apply record-recovery --sealed <INTERRUPTED_SEALED_PLAN> --resumed <RESUMED_SEALED_PLAN> --target-hardware-id <HOST>`, never by hand.

### Timing and the sweep's positive control

The observation's unit sweep reads Cloud Asset Inventory, which indexes new resources with a delay (minutes; GF5, unverified).

**A clean sweep counts only after it has listed the run's own topic** (#358 review N2). A query that Google accepts but that matches nothing returns a complete, empty answer. On its own, that answer looks exactly like "nothing unexpected carries the run's labels", so it would pass silently, never fail closed. The positive control closes that gap:
- `./alz apply observe` checks it for you. When the topic's own read shows it present but the sweep does not list it, the inventory is `INCOMPLETE` and the verdict is `INCONCLUSIVE`, never `VERIFIED`. The message names the topic that was not listed.
- Right after an apply, that is usually the indexing delay. Rerun `./alz apply observe --sealed <SEALED_PLAN>` after a few minutes. E7 counts only an observation whose verdict is `VERIFIED` with the inventory `COMPLETE`, which means the sweep listed the topic.
- **A live query that never matches leaves the path `INCONCLUSIVE` indefinitely.** That is the fail-closed signal for GF3, not an indexing delay. If the topic is still not listed after 30 minutes, the sweep query matches nothing on this project. Rerunning observe will not change that, and no observation of this run will ever read `VERIFIED`. Record it as a GF3 finding (or GF5, if a later observe lists the topic after all). Do not count any clean sweep from this run as evidence, including the seal's empty sweep (E4) and the cleanup verification (E8), and do not change the query by hand.
- **The cleanup does not wait for the sweep** (coordinator decision on #39). The run's own verified topic may be proposed and deleted while the observation is `INCONCLUSIVE`. `./alz apply verify-cleanup` then records `"strays": "UNPROVEN"` and the disposition `INCOMPLETE` (code `CLEANUP_STRAYS_UNPROVEN`), and the lifecycle report's leftovers stage is not `PASS`. **E8 counts only a leftovers record with `"strays": "PROVEN"`**, which the product writes only when an observation of this run passed the control (`sweepControlPassedAt` in the observation record). An `UNPROVEN` record is never a clean leftovers result, and the evidence runner reports it as `LEFTOVERS_NOT_VERIFIED`, never as a pass.
- A listing that fails or stops part-way also makes the verdict `INCONCLUSIVE`. Never record `PASS` by hand.

### If the observation reports `CREDENTIALS`: check GF1 first

The independent observation (`./alz apply observe`) gets DISCOVERY's token through the product's own token exchange (`src/tools/gcp-credentials.ts`, D20), not through Terraform's.
- The exchange is form-encoded, with snake_case names, as Google's auth libraries send it. Whether Google's security token service accepts that form is **GF1, still open**.
- A live rejection of the encoding answers HTTP 400. The product reports a 400 or 401 from the exchange as `CREDENTIALS`, the same class as a misconfigured identity.
- So on the first live run, a `CREDENTIALS` reading before any resource is read is **first the open GF1 question**, not proof of a bad identity. Record it, and do not change grants or the identity to make it pass.
- The refusal carries only its class. The HTTP status and the response body are never shown, because a response can quote a token.
- Engineering settles GF1 from that evidence: the encoding, not the identity, is what changes.

### Manual resolution (review note N-3 of the API record)

If the governed cleanup cannot run and a person deletes the topic by hand, a rerun of `./alz apply observe --sealed <SEALED_PLAN>` reports the topic `MISSING` and the observation `FAILED`. **That is the expected result for an absent topic**, not a new fault (EMULATED: `test/apply-emulated-gcp.test.ts`, "a hand-deleted topic observes as FAILED"). Record three things: the manual deletion, who made it, and the Cloud Audit Logs entry for the `DELETE`. A manual deletion is not a product cleanup. E8 stays open until a governed cleanup is recorded, or the owner records the exception.

### What never counts as live evidence

All of these are SYNTHETIC or EMULATED, and are listed so nobody mistakes them for acceptance:
- `test/apply-gcp-admission.test.ts`, `test/apply-gcp.test.ts`, `test/observe-gcp.test.ts`: fake Terraform, a scripted Google.
- `test/apply-emulated-gcp.test.ts`: the real driver, the real Terraform and the real google 8.9.0 provider, against a loopback emulator of Google's endpoints. It proves the product's flow, the judge on the real plan shape and the state separation under `embedStateWrite`. It does not prove IAM, scopes or anything else about Google.
- `bootstrap/gcp`'s `terraform test`: a mocked provider.

## Path 6: GCP API-native, DEV only

### What is being accepted

The same canary as path 5, made without Terraform: one labeled `google_pubsub_topic` in the DEV project, created by one `PUT` of an approved sealed request and deleted by one `DELETE` of an approved cleanup proposal. The engine runs in process (`src/apply/engines/gcp-api.ts`); there is no state, no external program and no state bucket. The project is the committed request [`qualification/gcp/act-dev1-canary-api/request.json`](../qualification/gcp/act-dev1-canary-api/request.json), exactly `{ "schemaVersion": 1, "kind": "PUBSUB_TOPIC" }` (D7). Every other value comes from the reviewed contract, the run's unit and the name suffix drawn once at seal (D4, D10). The design is `docs/act-pilot-gcp-api-driver.md` (D1 to D20) and the engine page is `docs/act-pilot-gcp-api.md`.

The acceptance items are the same as path 5's, and F1 to F10 below map onto them.

### Owner inputs (never posted on #39 as credentials)

| Input | Where it goes |
| --- | --- |
| The DEV project id and one region | `targets.DEV.projectId` and `targets.DEV.region`. The region becomes the topic's `messageStoragePolicy.allowedPersistenceRegions` (D11). |
| The topic namespace | `targets.DEV.topicPrefix`: `alz-`, then 1 to 40 of `a-z 0-9 -`, ending in `-` (D4). Each run's topic is the prefix plus 12 hex characters drawn at seal. |
| The parent (optional) | `targets.DEV.parent`, owner-declared and never observed: the path never reads Resource Manager (D9). |
| The execution host and its workload identity federation | `bootstrap/gcp` with `engine = "GCP_API"`: DISCOVERY and APPLY only, D12's custom roles, no state bucket. The eight `ALZ_DISCOVERY_GOOGLE_*` and `ALZ_APPLY_GOOGLE_*` variables on the host. |
| Approvers and the requester | `approvers` and `requiredApprovals.DEV` in the contract, as for path 5. |

### The contract

Build it from the bootstrap outputs (`contract_target`, `GCP_API`):
- `"provider": "GCP"`, `"engine": "GCP_API"` and `"enabledEnvironments": ["DEV"]`: path 6 is DEV only, and a contract for any other stage does not load.
- `targets.DEV.backend` is exactly `GCP_API_NO_STATE` and `targets.DEV.workspace` exactly `default` (D9). **No `embedStateWrite`**: the path has no state, and a contract that sets it does not load.
- `targets.DEV.canary` is exactly `{ "resources": [{ "type": "google_pubsub_topic", "count": 1 }] }` (D8).

### Evidence, step by step

The commands are path 5's, with the API request in place of the Terraform project. "Kept" has the same meaning. One channel per workflow.

| # | Acceptance item | Command | The owner must see | Kept |
| --- | --- | --- | --- | --- |
| F1 | Authorization and canary scope | `./alz apply contract-check --file config/act-pilot-contract.json`, the reviewed authorization commit, then `./alz apply status --environment DEV` | COMPLETE; `"act": "PILOT_ENABLED"` with DEV AUTHORIZED for `GCP GCP_API` | the commit and its review; the status output |
| F2 | Two identities, separate, aimed at the DEV project | `./alz apply preflight --environment DEV` | every item READY except qualification; exactly DISCOVERY and APPLY, no STATE or STATE_WRITE, no ambient Google variable | the preflight output |
| F3 | Qualified identities | `./alz apply prepare --environment DEV --project <COPY of qualification/gcp/act-dev1-canary-api>`, then `./alz apply qualify --request <REQUEST.json> --manifest <MANIFEST.json>` | qualification signs both identities in and runs one Cloud Asset search as DISCOVERY; APPLY makes no Pub/Sub call. Before typing the attestation, check the Cloud Audit Logs: DISCOVERY only read, APPLY made nothing | the qualification evidence |
| F4 | An exact plan | `./alz apply seal --request <REQUEST.json> --manifest <MANIFEST.json> --requester <ID> --key <REQUESTER_KEY.pem>` | the review bundle lists exactly **1 create**, `google_pubsub_topic.<topicPrefix><12 hex>`, and the unit's labels; the sealed topic read absent and the unit sweep complete and empty | the sealed plan and review bundle |
| F5 | Human approval and execution | `./alz apply approve ...`, then `./alz apply apply --request <APPLY_REQUEST.json> --manifest <MANIFEST.json> --sealed <SEALED_PLAN> --approval <APPROVAL.json>` | outcome `SUCCEEDED`; the evidence's mutation is `GCP_PUBSUB_TOPIC_CREATE_OF_SEALED_REQUEST` and it names `verifiedProperty` `messageStoragePolicy.allowedPersistenceRegions` = `[the contract's region]` | the apply evidence and the blueprint record (source `GCP_API_TOPIC`) |
| F6 | Live record | `./alz apply record-live --sealed <SEALED_PLAN>` | `cloud: "GCP"`, `engine: "GCP_API"`, the same commit, contract and target hashes | `config/acceptance/evidence/gcp-gcp_api-execute-dev-<artifact>.json`, committed |
| F7 | Independent observation, with the sweep's positive control | `./alz apply observe --sealed <SEALED_PLAN>`, rerun after the indexing delay while it reports that the sweep did not list the run's topic | verdict `VERIFIED`, verifier `GCP_REST`, inventory `COMPLETE` (so the sweep listed the run's own topic: path 5's "Timing and the sweep's positive control"), and `sweepControlPassedAt` set in the observation record; the topic `VERIFIED` with the contract's storage policy. A query that never matches keeps F7 `INCONCLUSIVE` indefinitely: that is GF3's fail-closed signal, not an indexing delay. | the observation record |
| F8 | Verified cleanup | `./alz apply propose-cleanup ...`, `./alz apply approve ...`, `./alz apply cleanup ...`, `./alz apply verify-cleanup --proposal <PROPOSAL.json>` | the proposal deletes exactly the run's topic; the cleanup evidence's mutation is `GCP_PUBSUB_TOPIC_DELETE_OF_RUN_TOPIC` with `deletedByRun: true`; afterwards the topic is `CONFIRMED_DELETED` (basis `GCP_REST_ABSENT`), and the leftovers record says `"strays": "PROVEN"` with the disposition `COMPLETE`. `UNPROVEN` (no observation passed F7's control) is not a clean result. | the proposal, cleanup evidence and leftovers record |
| F9 | Bound evidence | `./alz apply report --sealed <SEALED_PLAN> --proposal <PROPOSAL.json>`, then `./alz qualify admission --manifest <evidence-index-file>` | a report for gate `act:gcp-gcp_api` (never `act:gcp-terraform`) tying F4 to F8 together | the report and the admission output |
| F10 | Denial, replay, interruption and recovery | path 5's E10, with this path's commands | `KILL_SWITCH_ACTIVE`; `ARTIFACT_ALREADY_APPLIED`; QA not READY | the outputs |

The guided runner drives F1 to F9 with `./alz evidence run --stage act:gcp-api`, then `--stage cleanup:gcp-api` (`docs/evidence-runner.md`).

### Facts only this run shows (GF1 to GF11)

`docs/act-pilot-gcp-api.md` records each fact and what happens if it is wrong. Most fail closed: the run is refused or reads `INCONCLUSIVE`, and nothing is created. One failure was silent until #358 review N2: a sweep query that Google accepts but that matches nothing returns a complete, empty answer. The positive control in F7 is what catches it (path 5's "Timing and the sweep's positive control"). Record what the run shows for each:
- **GF1**: the token exchange's form encoding. A `CREDENTIALS` refusal before any resource is read is GF1 first, as for path 5.
- **GF3**: the unit sweep sends `labels.alz-unit:<unit>`, the label syntax Cloud Asset documents, and keeps only results whose `alz-unit` label is exactly the unit (`:` matches tokens). If Google refuses the query, the seal is refused `UNIT_LISTING_INCOMPLETE` and nothing is created. If Google accepts it but it matches nothing, only F7's positive control shows that. Record the answer either way, and do not change the query by hand.
- **GF4 to GF6**: the read-back after the `PUT`, Cloud Asset's indexing delay, and the answers to a duplicate create (409) and to a `DELETE` of an absent topic (404).
- **GF7 to GF11**: the custom roles and grants of D12, from the bootstrap and the Cloud Audit Logs.

### What never counts as live evidence

- `test/apply-gcp-api.test.ts`: the engine against an in-memory emulator (SYNTHETIC).
- `test/apply-emulated-gcp-api.test.ts`: the real driver (seal, apply, observe, propose, cleanup, verify) against a loopback emulator of Google's four hosts (EMULATED). It proves the product's flow, not Google's behavior.
