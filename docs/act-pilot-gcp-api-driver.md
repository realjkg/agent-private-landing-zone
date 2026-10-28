# Decision record: GCP API-native ACT (path 6) on the pilot driver

Status: **D4, D9, D11, D12, D16 ACCEPTED by the owner (#39 6483366237); the rest are reviewer-recommended (#338 review 6481933897); the coordinator accepted them under the no-deadlock rule.** The owner's constraints are written into each accepted decision below. This record is design only. It changes no code, and it authorizes no execution, spending, IAM change or publication. **ACT = DISABLED**: the repository ships no pilot contract, and nothing here has run against Google Cloud.

- **Lane:** G2-D (#39, coordinator PLAN 6481447333 and its corrections 6481493381).
- **Basis:** owner decision 6481421924 (GCP ACT is in the DEV release); the open questions in #323's body; review 6453205218 on #323; reviewer status 6453239887.
- **Base inspected:** `main` at `028e306`, after INT-1a (#339) merged. First drafted at `55b8e6a` and reviewed at `08716fa` (#338).
- **Implemented by:** lane G2, engine-local only (`src/apply/engines/gcp-api.ts` and its tests and docs), only after this record is approved. The shared files named below, `src/teardown/manifest.ts`, `src/teardown/types.ts`, `src/apply/unit.ts`, `src/observe/blueprint.ts` and `src/tools/gcp-credentials.ts` included, belong to the single serialized integrator (INT), one step at a time (coordinator defaults, #39 6481739345). The `gcp-rest` scope fix (D15) belongs to G1 after INT-1a merges, or stays with INT-1a if its reviewed diff already makes it.

## How to read this record

Each decision has a number (D1 to D20), the decision, why, and what was rejected. Each one is marked:

- **[OWNER]**: the decision changes authority: what the reviewed contract authorizes, an identity's grants or token scope, a deletion authority, or a residual risk the owner accepts. The owner decides it on #39. All five (D4, D9, D11, D12, D16) are now **ACCEPTED** (6483366237), with the constraints each section states.
- **[REVIEWER]**: engineering inside the authority the owner already granted. Independent review approves it.

A short table of every decision and its mark is at the end ("Decision index").

Where a fact about a Google API is relied on and has not been checked against Google's published reference, it is marked **UNVERIFIED (GFn)** and listed under "Facts to verify before G2 merges". The labels GF1 to GF11 name Google API facts; G1 and G2 elsewhere name lanes. Nothing is checked by a live call; the owner's DEV run is the only live evidence.

## 1. Where the engine stands today

PR #303 (merged as `a728e33`) put a working, SYNTHETIC-tested engine on `main` in `src/apply/engines/gcp-api.ts`. It is **not** an `EngineSpec` and nothing in the product reaches it: `src/apply/contract.ts` lists GCP `GCP_API` in `PLANNED_PATHS`, so a contract naming it is refused as `NOT_IMPLEMENTED`.

It exports five standalone functions: `sealGcpApiPlan`, `verifyGcpApiPlan`, `applyGcpApiPlan` (async), `observeGcpApiPlan` and `cleanupGcpApiPlan`. Each one re-implements, in a smaller form, something the driver (`src/apply/driver.ts`) already owns:

| Concern | The engine today | The driver |
|---|---|---|
| Requester signature | its own `signRequest` call at seal and `verifyRequestSignature` at apply, against an allowlist slice `GcpApiTarget.approvers` | `sealPlan` signs under the REQUEST domain; `runApply` verifies before and again right before the approvals are consumed |
| Once-only ledger | its own `ledgerDir` with `claim`, `record`, `stateOf` and `ledgerPrivate` | `reserveArtifact`, `requireNotApplied`, `finalizeArtifact`, `releaseReservation` in the evidence directory, and the cleanup ledger |
| Target | its own `GcpApiTarget { environment, projectId, approvers }` | `targetForEnvironment`, `pilotTargetSha256`, `targetMoved` over the reviewed contract |
| Kill switch | a `killSwitch()` callback | `admit`, the re-admission before consumption, and `control.stopWhen` while the engine runs |
| Approvals, human invocation, channel, source commit, authorization | none | all of them |
| Evidence | `CallEvidence` lists in results | `ApplyEvidence`, the blueprint, the observation, the cleanup proposal, `CleanupEvidence`, leftovers |
| Observation | `observeGcpApiPlan`, by the engine itself | `observeRun`, through the independent reader of the provider |

The owner's direction is to reuse the driver's authorization, signature, approvals, ledger and evidence, with no parallel authority. So path 6 becomes **one more `EngineSpec`, `GCP_API`, in `SPECS`**, and the five standalone functions go away. What stays from #303 is the part that is genuinely this engine's: the typed request check, the derived REST calls, the network gate, the WIF token exchange and the topic read.

## 2. The six open questions

### D1. READY "binary" hash: bind the module source closure [REVIEWER]

**Question.** `EngineSpec.binarySha256` is the hash of the program a run executes. Qualification evidence binds it (`verifyApplyQualification`, field `terraformSha256`), the seal records it (`PreviewProvenance.engineBinarySha256`), and `engineBinaryChange` refuses an apply when it changed. GCP_API runs no program.

**Decision.** `binarySha256` returns the SHA-256 of a named, canonical preimage:

```
canonicalJson({ kind: "IN_PROCESS_MODULE", engine: "GCP_API",
  files: [ { path, sha256 }, ... ] })   // sorted by path
```

- `files` is the engine module **and its transitive in-repository imports**, as loaded by the running product (the `.ts` sources under `tsx` in a checkout, the `.js` files in the packaged image), each read from disk relative to the module's own URL.
- The list is a reviewed constant in the engine (`GCP_API_MODULE_FILES`). A unit test computes the real import closure of `gcp-api.ts` and fails when the constant differs, so an added import cannot escape the hash.
- Any file missing or unreadable gives `undefined`. The driver already refuses that at seal ("the engine program cannot be found or read") and at apply (`ENGINE_BINARY_CHANGED`), so `undefined` never means "unknown, go ahead".
- `executables` is `[]`. `prepare.ts` and `readiness.ts` loop over it, so an empty list means "no external tool".

**Why.** It is the reviewer's recommendation (6453205218, item 1): a closure, not one file, and an explicit name so the value can never be mistaken for a program hash. Qualification then binds exactly the engine code that was qualified. The driver's existing `sourceCommit` rule is a different thing: it ties the apply to the commit that sealed, while this hash ties qualification evidence to engine code across commits that do not change it.

**Rejected.**
- `sourceCommit` as the hash: every commit would void qualification evidence, even a docs change.
- One file's hash: an edit to an imported module (the credential check, the network gate) would not requalify.
- A release artifact digest: there is no signed per-engine artifact today, and a checkout run would have none.

**Schema.** No evidence schema change. The value still lands in `terraformSha256` and `engineBinarySha256`; their doc comments gain "or, for GCP_API, the `IN_PROCESS_MODULE` hash". Renaming those fields is a separate, cross-engine change and is not needed here.

### D2. Requester signature: the driver's only [REVIEWER]

**Decision.** The engine never signs and never verifies a requester signature. `sealPreview` checks the requester (`requesterRefusal`, with the environment) before any engine runs; `sealPlan` signs the artifact hash under the REQUEST domain; `runApply` verifies it, and again against the re-admitted contract immediately before the approvals are consumed.

**Why.** It removes the second signing path that #321 N2 had to patch (the engine's `requesterKeyRefusal` call that did not judge the environment). One check has one enforcement point, as `engine-spec.ts` requires. The reviewer agreed (6453205218, item 2).

**Consequence.** The engine stops importing `signRequest`, `verifyRequestSignature` and `requesterKeyRefusal`. The comment on `requesterKeyRefusal` in `src/apply/approval.ts` that names GCP_API is updated in the same change.

### D3. Once-only ledger: the driver's only [REVIEWER]

**Decision.** The engine keeps no ledger. The driver's apply ledger reserves the artifact before the engine exists, refuses a second apply (`requireNotApplied`), releases the reservation when the engine never started, and replaces it with evidence whatever the outcome. Cleanup uses the driver's cleanup ledger under the proposal hash.

**Why.** Two ledgers with different meanings for one run is parallel authority. The driver's ledger is encrypted, lives in the evidence directory, and is what `record-recovery`, `observe`, `propose-cleanup` and release admission already read. The engine's own ledger was the only thing deciding what its cleanup could delete; under D6 the run's records decide that instead.

**Kept from the reviewer's note** (6453205218, item 3): the `PUT` that creates the topic is sent once, after the approvals are consumed, and an `ALREADY_EXISTS` (409) answer is never success (D14).

### D4. Target shape: a dedicated topic field, not `backend` [OWNER: ACCEPTED, 6483366237]

**Question.** #323 proposed `backend` = topic id and `workspace` = `default`. The reviewer (6453239887, 6453205218 item 4) disagreed: everywhere else `backend` means the state location, `gcpBackendBuckets` splits it on `/`, and the cleanup classifier protects it as `PROTECTED_BACKEND`. A topic id there would be protected as a backend or misparsed. The reviewer recommended a dedicated `topicId` field.

**Decision.** A dedicated engine target field, **`topicPrefix`**, declared in `EngineSpec.target.fields` (as Bicep declares `resourceGroup`), and listed in `locationFields` so it joins the target hash.

- `topicPrefix`: an exact string matching `^alz-[a-z0-9-]{1,40}-$`, for example `alz-act-dev1-`.
- The run's topic id is `topicPrefix` followed by a 12-character lowercase hex suffix drawn at seal (D10). The full id therefore matches the existing `TOPIC_ID` rule (`alz-`, at most 64 characters).
- `backend` is a fixed, validated sentinel: `backendOk` accepts exactly `GCP_API_NO_STATE`. Upper case and underscores cannot occur in a topic id, a bucket or a prefix, so the sentinel can never be read as, or collide with, a real name.
- `workspace` is exactly `default` (`workspaceOk`), as for Bicep.
- `backendMayRepeat: true`. The path is DEV only, so there is no second environment to compare.

**Why a prefix and not `topicId`.** The reviewer's point is kept: a dedicated field, never `backend`. But owner decision 6481421924 (after the reviewer's note) requires **distinct names and ownership per run**. A fixed `topicId` in the contract would give every run the same name, so each new run would need a new reviewed contract commit. The prefix is the part the owner authorizes in a reviewed commit; the run-unique suffix is chosen by the product at seal, sealed into the artifact and signed by every approver.

**Why [OWNER].** The target is the content of the owner's authorization. This decision sets what the owner's reviewed commit names for this path, and it departs from both the #323 proposal and the reviewer's `topicId` wording.

**Owner's constraints (accepted, 6483366237).**
- `topicPrefix` is bound into the target hash (D9).
- The run-unique suffix is generated **once, at seal**. The approval preview (the change list and review bundle) shows the **full topic name**, so each approver signs one exact topic.
- Apply, observation and cleanup reuse that exact sealed name. Nothing regenerates it on apply or on retry: `rederive` takes the suffix from the sealed artifact, and the blueprint and the cleanup address come from the sealed change list. When the engine never started (`APPROVALS_SPENT`, `KILL_SWITCH_AFTER_APPROVALS`), the driver releases the reservation and recovery reapplies the same sealed plan (same name) with new approvals. After the plan is spent (`FAILED_NO_CHANGE`, `PARTIAL_REQUIRES_REVIEW`), recovery is a new seal (a new name) with new approvals. Nothing ever renames a sealed plan.
- `backend = GCP_API_NO_STATE` and `workspace = default` are validated compatibility values only. No code path reads them as a state location.
- The prefix authorizes a namespace. Each approval authorizes one exact topic in it, never arbitrary topics in the project.

**Rejected.**
- `backend` = topic id: the reviewer's objection stands.
- `topicId` fixed in the contract: conflicts with distinct names per run.
- No topic field at all, with any `alz-` name accepted: the owner would not be authorizing a name space, only a project.

### D5. Synchronous `EngineSpec.plan`: widen the steps that read the cloud [REVIEWER]

**Question.** `EngineSpec.plan` is synchronous; the Terraform, CDK and Bicep engines spawn processes synchronously. GCP_API reads Google over HTTPS with `fetch`, which is asynchronous.

**Finding.** Widening `plan` alone is not enough. To keep every precondition read **before** the approvals are consumed, these steps also need to await a read: `qualify`, `EngineApplyRun.prepare`, `EngineApplyRun.rederive`, `EngineCleanupRun.prepare` and `EngineCleanupRun.planDestroy`. Today Bicep re-reads its stack inside `execute`, after consumption, which turns a stale stack into `APPROVALS_SPENT`; path 6 should not copy that.

**Decision.** One interface change, in its own PR by INT, **before** G2:

- Each of those six methods returns `T | Promise<T>`.
- `seal.ts` (`runSeal`, `build`, `planWithoutStoring`) and `driver.ts` (`planAgainstTarget`, `runApply`, `runCleanup`) `await` each call, in the order they already run.
- The Terraform, CDK and Bicep engines are unchanged: awaiting a plain value is the value. Their tests must pass unchanged.
- `stateDocument` stays synchronous. GCP_API returns the document it read during `settle`, which is already allowed to be async (D7).

**Why.** It is the reviewer's recommendation (6453205218, item 5), widened to every step that must read before consumption. The order of the gates stays deterministic because every call is awaited where it stands.

**Interruption.** An await gives the signal handler a chance to run. In `runApply` the driver reads `interrupted` twice: once after the reservation and before `prepare`, and once after `rederive` and the change-list comparison, right before re-admission and consumption (after `yieldToSignals`). It does not read it between `prepare` and `rederive`. Because that second read follows every awaited read, an interrupt during an awaited `prepare` or `rederive` still stops the run with nothing consumed. `runCleanup` has the same two reads around `prepare` and `planDestroy`. A test covers it (section 5).

### D6. The cleanup hook: `stateDocument`, then the driver's own cleanup flow [REVIEWER, with D16 for the owner]

**Decision.** GCP_API implements `stateDocument`, `cleanupAdapter`, `openCleanup` and `cleanupMutation`, and its cleanup is the driver's `runCleanup`, unchanged:

1. After `settle`, `stateDocument()` returns `{ source: "GCP_API_TOPIC", document }`, where `document` is the topic's resource name and labels as the engine's DISCOVERY read-back saw them. The driver writes the blueprint with it (`keepBlueprint`) and drops the document.
2. A new mapper `blueprintFromGcpApiTopic` turns it into one blueprint entry: address `google_pubsub_topic.<topicId>`, type `google_pubsub_topic`, id `projects/<project>/topics/<topicId>`, origin `IN_PLAN` only when the sealed change list names that address.
3. `./alz apply observe` reads it with the independent GCP reader (D15) and records the observation.
4. `./alz apply propose-cleanup` derives the proposal from the records. `gcpProtectionOf` classifies `google_pubsub_topic` as a reviewed leaf, so the run's topic is the one deletion.
5. `runCleanup` verifies the proposal against the records, the requester and the cleanup approvals, reserves the proposal, and only then runs the engine's cleanup (D16).
6. `./alz apply verify-cleanup` records verified absence.

**Why.** It is the reviewer's condition (6453205218, item 6): the same proposal, requester, approvals and observation as every other cleanup; an evidence-bound document, not a mutable file; deletion of the exact recorded name only, after a label-match read.

**Rejected.** The engine's `cleanupGcpApiPlan`: its authority came from the engine's own ledger, which D3 removes.

## 3. The rest of the design

### D7. Typed request and how the "plan" is represented [REVIEWER]

**The project.** The driver seals a manifest-bound project. For GCP_API the project is one file, `request.json`:

```json
{ "schemaVersion": 1, "kind": "PUBSUB_TOPIC" }
```

That is the whole requester-supplied request. Exactly these two keys; any other key is `FIELD_NOT_ALLOWED`, any other kind `KIND_NOT_ALLOWED`. Everything else is derived, so a requester cannot ask for anything the contract does not already say:

| Sealed field | Derived from |
|---|---|
| `projectId` | the contract target's `projectId` |
| `topicId` | the target's `topicPrefix` plus the seal's 12-hex suffix (D10) |
| `labels` | the run's pilot unit (`alz-managed-by`, `alz-unit`, `alz-build`; D10) |
| `messageStoragePolicy` | the target's `region` (D11) |
| the three calls | `projectId` and `topicId` |

The committed typed-request example that PLAN 6481447333, section 2 asks for is that file, under `qualification/gcp/act-dev1-canary-api/request.json`. Its manifest binds the file's hash, the engine (`GCP_API`), the engine version (the engine's own version string, for example `gcp-api-1`), no providers and no lock file.

**The artifact** (`plan` returns these bytes, which the apply runs verbatim): the canonical JSON of

```
{ schemaVersion: 1, kind: "GCP_API_PUBSUB_TOPIC", projectId, topicId, labels,
  messageStoragePolicy: { allowedPersistenceRegions: [region] },
  precondition: "ABSENT",
  create:   { method: "PUT",    url: "https://pubsub.googleapis.com/v1/projects/<p>/topics/<t>",
              body: { labels, messageStoragePolicy } },
  readBack: { method: "GET",    url: <same> },
  cleanup:  { method: "DELETE", url: <same> } }
```

**The change list** the approvers read: exactly one line, `{ address: "google_pubsub_topic.<topicId>", type: "google_pubsub_topic", action: "CREATE" }`. `CREATE` is the vocabulary `cleanup-proposal.ts` already requires of a deletable entry.

**What the seal binds** around it is the driver's, unchanged: `planSha256` of those bytes, the manifest hash, the release identity, the environment and target, `targetSha256`, `contractSha256`, `authorizationSha256`, the channel, `sourceCommit`, the provenance (D1), the unit, the requester id, and the requester's signature over `artifactSha256`.

**Re-derivation.** `rederive` parses the artifact, derives every field again from `request.json` (through the snapshot), the contract target, the unit and the sealed suffix, and refuses `ARTIFACT_TAMPERED` unless the bytes are identical. A plan carrying any other call, URL or body is therefore refused before the approvals are consumed. This replaces `verifyGcpApiPlan`.

### D8. Canary allowlist [REVIEWER; the entry itself is the owner's input]

**Decision.**
- `canaryTypeOk(value)` accepts exactly `google_pubsub_topic`. A wildcard, a pattern or any other type is refused when the contract is read.
- `plan` and `rederive` both call `assertCanary(pinned.canary, [{ address, type: "google_pubsub_topic", action: "CREATE", creates: true }], "request")`. So the owner's entry must be `{ "type": "google_pubsub_topic", "count": 1 }`. A count other than 1 always refuses (`found !== count`), and `retain` is refused because the type is not in `RETAINABLE_CANARY_TYPES`.
- Create only: the engine has no update, replace or import, and the change list has one `CREATE`.

**Why `google_pubsub_topic` and not `pubsub.googleapis.com/Topic`.** The product already has one reviewed GCP type vocabulary: the GCP reader's `GCP_READ_TYPES`, the cleanup classifier's `GCP_LEAF_TYPES`, and path 5's canary all say `google_pubsub_topic`. Reusing it means the reader and the classifier need no new type, no second leaf-type review is needed, and both GCP paths' canaries read the same. The Cloud Asset type name appears only inside the reader's label sweep.

**Rejected.** `pubsub.googleapis.com/Topic`: more faithful to the API, but it would add a second name for the same resource to the reader, the classifier and the evidence, each needing review.

### D9. Full target shape and the target hash [OWNER: ACCEPTED, 6483366237]

The GCP provider spec came from INT-1a (#339, on `main` at `028e306`). There, `projectId` and `region` are account fields (`accountFields`), and `parent` is an optional target field (`optionalTargetFields`). `pilotTargetSha256` hashes the account fields, the engine's `locationFields` and every optional field the target states, so all three are bound with no extra `locationFields` entry. GCP_API adds `topicPrefix`. A DEV target:

```json
"DEV": {
  "projectId": "<DEV project>",
  "region": "<region, for example us-central1>",
  "parent": "folders/<number>",
  "backend": "GCP_API_NO_STATE",
  "workspace": "default",
  "topicPrefix": "alz-act-dev1-",
  "canary": { "resources": [ { "type": "google_pubsub_topic", "count": 1 } ] }
}
```

| Field | Rule | In `pilotTargetSha256` | Who checks it at run time |
|---|---|---|---|
| `projectId` | the GCP provider's project id rule | yes (account field) | every URL; each identity's service account must be of this project |
| `region` | the GCP provider's region rule | yes (account field) | sealed as the topic's storage policy and read back (D11) |
| `parent` | optional, `folders/<n>` or `organizations/<n>` | yes, when present (`optionalTargetFields`) | **not read by this path.** DISCOVERY holds no Resource Manager grant. Wherever it appears (preview, evidence, reports) it is labeled **owner-declared, not observed**, and no evidence claims verified folder or organization placement |
| `backend` | exactly `GCP_API_NO_STATE` | yes | the contract reader |
| `workspace` | exactly `default` | yes | the contract reader |
| `topicPrefix` | `^alz-[a-z0-9-]{1,40}-$` | yes (`locationFields`) | every derived topic id must start with it |
| `canary` | D8 | yes | seal and apply |

Moving any of these is a target move. Every field is preserved through apply, observation, cleanup proposals, approvals and evidence, because each of them carries the run's `targetSha256`.

**A target change never redirects an earlier run's cleanup.** This was checked against `runCleanup` in `src/apply/driver.ts`:
- The proposal binds the run's `targetSha256` from its apply evidence. The driver refuses with `TARGET_NOT_IN_CONTRACT` (`targetMoved`) unless the contract committed now hashes to exactly that target, once at admission and again right before consumption. A changed prefix, project, region, parent or canary stops the cleanup; it is never reinterpreted under the new values.
- The topic to delete is not read from the current contract. It comes from the run's records: the sealed plan's change list (`google_pubsub_topic.<topicId>`) and the blueprint id, which `requireProposalDerivedFromRecords` rebuilds and compares by hash. The engine's `planDestroy` then checks that address against the pinned target, which matches the sealed one exactly (the hash check above).
- So cleanup runs on the run's sealed target and sealed name. A run under an older target is cleaned up by restoring that target in a reviewed contract, or by a person by hand. Nothing silently follows a newer target.

**Contract scope.** GCP_API joins `DEV_ONLY_PATHS`, so the contract must state `enabledEnvironments: ["DEV"]`, and it leaves `PLANNED_PATHS`. Both are INT-2's change, after G2 is reviewed.

**For the cleanup classifier.** With GCP_API, the state-bucket list the classifier protects is empty (there is no state). The sentinel is never parsed as a bucket. This is INT's change to `gcpBackendBuckets` when the GCP provider lands.

**Why [OWNER].** The same reason as D4: these fields are what the owner's reviewed commit authorizes. The owner inputs listed in decision 6481421924 fill them: the project, the location constraint and the target identifiers (here, the prefix). **Accepted** (6483366237), with the `parent` labeling and the no-redirect rule above.

### D10. Run-unique names and per-run ownership [REVIEWER]

**Name.** At seal, `plan` draws 6 random bytes (12 hex characters) and the topic id is `topicPrefix + suffix`. The suffix is inside the artifact, so every approver signs the exact topic name. A new seal is a new name and a new artifact. This also replaces #303's `sealNonce`, whose only job was to make each seal a new artifact.

**Unit.** The unit stays the product's: one unit per contract target, from `pilotUnitOf`. The change is **scoped to GCP_API only** (INT, `src/apply/unit.ts` and `DeletionUnitStateRef` in `src/teardown/types.ts`): for a GCP_API contract the state reference names engine `GCP_API` with backend kind `pubsub`, a new variant of that type. Every other engine keeps today's reference (`engine: "TERRAFORM"` and its provider's backend kind) byte for byte, so the unit id and the `alz-unit` tag of AWS and Azure Terraform, CDK and Bicep runs do not change; a regression test pins their unit ids. Every run under one target therefore carries the same `alz-unit` label, which is what makes the independent sweep useful: a topic from an earlier run that is still there shows up as `unexpected` in a later run's observation.

**Ownership per run** comes from the run's records, as for every path: the sealed plan names the exact topic, the blueprint maps it to one id, the observation checks it, and the proposal is derived from those. A label alone never makes a topic deletable (`src/teardown/unit.ts`).

**One open run per target: checked twice, not guaranteed.** The canary count of 1 limits one plan to one topic; it says nothing about topics earlier runs left. The target-wide rule is a separate check, run at two points with the GCP reader's `listTagged(unit)` (DISCOVERY, Cloud Asset):

1. **At seal**, in `plan`: anything listed, or an incomplete listing, refuses the seal (`UNIT_NOT_EMPTY` or `UNIT_LISTING_INCOMPLETE`). The earlier run is cleaned up first.
2. **At apply**, in the async `prepare` (D5), before any approval is consumed: the unit sweep runs again, and the apply is refused (`UNIT_NOT_EMPTY`, `UNIT_LISTING_INCOMPLETE`, with nothing consumed) if it lists any topic of the unit or is incomplete. The sealed topic itself must also read absent by its own `GET`. So two plans sealed back to back cannot both be applied once the first one's topic is indexed: the second apply sees it and stops.

**Residual, stated plainly.** Cloud Asset Inventory is eventually consistent (minutes; UNVERIFIED GF5). Neither check sees a topic created inside the indexing window, so two applies run within that window (two sealed plans applied back to back, or concurrently) can **both create a topic, and two canary topics of one target can briefly coexist**. The record does not claim otherwise. What bounds it:

- each topic has its run-unique name and its own run records, so each is owned by exactly one run and cleaned up by that run's own proposal;
- each run's observation sweeps the unit and lists the other run's topic as `unexpected`, so its verdict is `FAILED` and the overlap is visible in evidence. **This holds only once the other topic is indexed** by Cloud Asset: an observation inside the indexing window does not see it either, and the overlap shows up only in an observation made after indexing (review note N-A, 6481933897);
- the canary still limits each plan to one create, so the overlap is bounded by the number of applies in the window.

Closing the window fully would need a target-wide lock in the driver's ledger (a per-target reservation alongside the per-artifact one), which does not exist today. That is a driver change outside this path; it is not proposed here.

**Rejected.**
- A per-run unit: the sweep could then never see an earlier run's topic.
- A requester-chosen run id in `request.json`: it would put naming back in the requester's hands, and a reused id would collide.

### D11. Location constraint: the sealed storage policy [OWNER: ACCEPTED, enforced, 6483366237]

**Decision (enforced).** The create body carries `messageStoragePolicy.allowedPersistenceRegions = [<target region>]`. The value is derived from the contract and sealed; the requester cannot set it.

- The engine's DISCOVERY read-back in `settle` requires the topic to report exactly that policy. A mismatch is never `SUCCEEDED`; it is `PARTIAL_REQUIRES_REVIEW`. Such a run gets **no product cleanup**: the driver makes no cleanup proposal for a run that did not end `SUCCEEDED` (D14, "Runs that did not succeed").
- It is read back independently as well: the blueprint entry carries the sealed policy, and the GCP reader's observation compares it (D15). A mismatch fails the check.
- Evidence names the exact property verified, `messageStoragePolicy.allowedPersistenceRegions`, and its sealed value. It names nothing more.
- **This is not a data-residency claim.** The record, the evidence and the console say only that this one Pub/Sub property was set and read back. They do not claim complete data-residency assurance for the topic, the project or Google's processing.
- The canary does no publishing, has no subscriptions and processes no payloads. No identity of this path holds a publish, subscribe or consume permission (D12).

**Why.** Owner decision 6481421924 lists a location constraint among the owner's inputs. A topic has no location of its own; its storage policy is the only location it carries, and without one the topic follows whatever the project or organization policy allows. Binding it makes the constraint both enforced (Google refuses a region an organization policy forbids, which is a definite 4xx, so `FAILED_NO_CHANGE` when the topic reads absent) and observable.

**Why [OWNER].** It decides what the owner's location input means on this path, and it adds a field to the create call that #303's engine deliberately forbade (`messageStoragePolicy` was `FIELD_NOT_ALLOWED`). The requester still cannot set it: it comes from the contract only.

There is no fallback: the owner rejected sending no policy (6483366237), so D14 and D16 always compare the sealed storage policy.

UNVERIFIED (GF4): that `topics.create` accepts the field on `PUT` with no `updateMask`, and that `topics.get` returns it as sent.

### D12. Identities and grants [OWNER: ACCEPTED, 6483366237]

**Identities.** `identities: ["DISCOVERY", "APPLY"]` and `attests: ["DISCOVERY", "APPLY"]`, two distinct runtime identities. **There is no STATE, STATE_WRITE or CHANGESET identity** on this path, and the driver refuses any other identity that is configured. The identity variables are path 5's: `ALZ_<IDENTITY>_GOOGLE_APPLICATION_CREDENTIALS` (a workload identity federation file source, checked by `checkCredentialConfiguration`) and `ALZ_<IDENTITY>_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT` (a service account of the target project). The checks run through the driver (`checkApplyIdentities`, `verifyIdentityTargets` and `GCP.ambientRefusal`), not the engine. WIF only: no key file, no ambient metadata credential, no `gcloud`, and the two identities must not collapse (`IDENTITY_COLLAPSED`).

**Grants.**

| Identity | Today (`bootstrap/gcp`, `engine = "GCP_API"`) | Accepted | Change |
|---|---|---|---|
| DISCOVERY | `pubsub.topics.get` | `pubsub.topics.get`, plus `cloudasset.assets.searchAllResources` granted on the DEV project only (project-scoped, explicitly reviewed) | **adds** the Cloud Asset search |
| APPLY | `pubsub.topics.create`, `pubsub.topics.delete` | unchanged: topic create and delete only | none |

**Owner's constraints (accepted, 6483366237).**
- APPLY has only topic create and delete. DISCOVERY has topic metadata reads and the project-scoped Cloud Asset search.
- No identity may publish or consume messages, change IAM, or enable APIs at run time. There is **no runtime API enablement**: if the Cloud Asset API (`cloudasset.googleapis.com`) must be enabled, the owner enables it at bootstrap (`bootstrap/gcp`), never a runtime identity. No runtime identity holds `serviceusage.services.enable`.
- No broad role is added: no Viewer, Editor or Owner, no `roles/cloudasset.viewer`, no `roles/pubsub.viewer` or other predefined Pub/Sub role, and no Service Account Token Creator. Impersonation stays the bootstrap's existing `roles/iam.workloadIdentityUser` binding of each identity's pool principal on its own service account. Every grant is a custom role listing exactly the permissions in the table.
- **The Cloud Asset search sees more than the code asks for.** `searchAllResources` on the project returns metadata (names, types, labels, locations and similar fields) of every indexed resource in the DEV project, not only Pub/Sub topics. The code filters to the unit label, but IAM does not, so DISCOVERY's metadata visibility is broader than the code's topic filter. That is why the grant is project-scoped, on the DEV project only, and reviewed explicitly.

**Checklist G1 verifies before bootstrap** (against Google's published IAM permissions reference, the custom-role supported-permissions list and the API discovery documents, with no live call). The results go into G1's `bootstrap/gcp` review:

1. [ ] `pubsub.topics.get` is the only permission `topics.get` needs, and it is supported in custom roles.
2. [ ] `pubsub.topics.create` alone permits `topics.create` with `labels` and `messageStoragePolicy`, and no other permission is needed for those fields (GF4, GF9).
3. [ ] `pubsub.topics.delete` alone permits `topics.delete`.
4. [ ] `cloudasset.assets.searchAllResources` at project scope is the only permission `searchAllResources` needs, and it is supported in custom roles at project level (GF10).
5. [ ] (Subject to GF7.) No custom role holds `pubsub.topics.publish`, `pubsub.topics.update`, `pubsub.topics.setIamPolicy`, any `pubsub.subscriptions.*`, any `*.setIamPolicy`, any `serviceusage.*`, or `iam.serviceAccounts.getAccessToken` beyond the existing `roles/iam.workloadIdentityUser` binding.
6. [ ] The APIs the path calls (`pubsub`, `sts`, `iamcredentials`, `cloudasset`) are enabled by the owner's bootstrap, and no runtime identity can enable a service.
7. [ ] The token scopes: the scope the STS exchange requests (the engine sends `cloud-platform`; GF8); `pubsub` for Pub/Sub `get`, `create` and `delete` (GF2); the narrowest scope Cloud Asset `searchAllResources` accepts (GF3).
8. [ ] `bootstrap/gcp`'s contract-target output for GCP_API matches D9's shape (`projectId`, `region`, optional `parent`, `backend`, `workspace`, `topicPrefix`, `canary`).

**Why the addition.** The independent observation's verdict depends on the unit sweep. Without it, `listTagged` fails, the inventory is `INCOMPLETE`, and the verdict can never be better than `INCONCLUSIVE`: the observe step could not pass. D10's one-open-run check needs the same read. Path 5's DISCOVERY already holds this permission, so the two GCP paths' DISCOVERY grants become alike.

**Token scopes.** See D15. The DISCOVERY token used for Pub/Sub reads carries the `pubsub` scope, as #303's engine already does, because Pub/Sub does not accept `cloud-platform.read-only` (UNVERIFIED GF2, but already the basis of #303). So DISCOVERY's read-only property rests on IAM, not on the OAuth scope.

**Why [OWNER].** Both are IAM or credential capability changes, which only the owner makes, and the bootstrap is the owner's to run. **Accepted** (6483366237), with the constraints above. The bootstrap edit and the checklist belong to G1's `bootstrap/gcp` review, with its outputs' contract-target template updated to D9's shape. This record changes no IAM.

### D13. What the preview proves, with no dry-run API [REVIEWER]

Pub/Sub has no dry-run or what-if for `topics.create`. The sealed preview proves:

1. The request is the allowlisted kind with no other field, and every derived value comes from the reviewed contract (D7).
2. The change is exactly one `CREATE` of `google_pubsub_topic`, within the canary (D8).
3. Under DISCOVERY, the exact topic is absent (`GET` gives 404) and the unit sweep is complete and empty (D10). Both are checked again at apply, before consumption; neither is a guarantee inside Cloud Asset's indexing window (D10, residual).
4. The identities are configured, separate and of the target project; DISCOVERY's token was minted and used.
5. The exact three calls, which approvers see in full.

It does **not** prove:
- that APPLY holds `pubsub.topics.create` (APPLY makes no call at seal; qualification attests the principal);
- that an organization policy accepts the region;
- that quota is available.

Each of those can only fail as a definite refusal of the one `PUT`, which D14 records as `FAILED_NO_CHANGE` after a read-back shows nothing was created.

**Rejected.** Calling `testIamPermissions` as APPLY at seal. It would prove the create grant, but it gives APPLY a call at seal. For Bicep that took an owner decision (E2, option A), and the gain here is small.

### D14. Execution, idempotency, interruption and recovery [REVIEWER]

**The apply** is `runApply`, unchanged. Its gates run in their usual order:

1. contract, kill switch, human, target, authorization;
2. sealed plan, channel, source commit, module hash (D1);
3. once-only (`requireNotApplied`), the requester and the approvals;
4. qualification and identities;
5. the reservation;
6. GCP_API's `prepare` and `rederive`;
7. the re-admission and re-verification, then consumption of the approvals;
8. `execute` and `settle`;
9. evidence.

**GCP_API's own steps.**
- **`prepare`** (async, D5): reads the target topic under DISCOVERY and runs the unit sweep again (D10). If the topic exists, `rederive` throws `PLAN_STALE`; if the sweep lists any topic of the unit or is incomplete, `prepare` throws `UNIT_NOT_EMPTY` or `UNIT_LISTING_INCOMPLETE`. Each is refused with nothing consumed.
- **`rederive`**: D7's byte-for-byte re-derivation and the canary check.
- **`execute(artifact, control)`**:
  - `control.stopWhen()` is read first; if the switch is on, the result is `notStarted` (the driver's `KILL_SWITCH_AFTER_APPROVALS`).
  - Then APPLY's token is minted, and `stopWhen()` is read once more.
  - A throw before the `PUT` is sent means the engine never existed (`APPROVALS_SPENT`: nothing was created).
  - Once the `PUT` is sent nothing throws: the one `PUT` is sent exactly once, never retried, and its status is kept for `settle`.
- **`settle`** reads the topic under DISCOVERY, at most `N` reads over a short window, and judges by positive evidence only:

| `PUT` answer | Read-back | Outcome |
|---|---|---|
| 200 | present, the sealed name, the sealed labels and storage policy | `SUCCEEDED` |
| 200 | anything else | `PARTIAL_REQUIRES_REVIEW` |
| 409 `ALREADY_EXISTS` | anything | `PARTIAL_REQUIRES_REVIEW`. Never success, and never "no change" (the reviewer's rule; a run-unique 48-bit name should not exist, so a person looks) |
| other definite 4xx (400, 403, 404, 429) | absent on every read | `FAILED_NO_CHANGE` |
| other definite 4xx | present | `PARTIAL_REQUIRES_REVIEW` |
| 5xx, or no answer | present with the sealed labels and policy | `SUCCEEDED` (the read is positive evidence the create landed) |
| 5xx, or no answer | absent, or unreadable | `PARTIAL_REQUIRES_REVIEW`. A create may still land, so it is never `FAILED_NO_CHANGE` without a definite refusal |

"Absent" in this table means the DISCOVERY `GET` answered 404 on every read. A read that fails (401, 403, 429, 5xx, no answer or an unexpected body) is unreadable, never absent, so it can only lead to `PARTIAL_REQUIRES_REVIEW`. "Present" with the wrong labels or the wrong storage policy is the "anything else" row, never `SUCCEEDED` (D11).

There is no `KILLED` outcome: one short call has nothing to stop part way. A signal during the `PUT` is settled by the read-back like a lost answer.

**Idempotency.** Each layer has one job:
- The driver's ledger applies an artifact once.
- The run-unique name means a new seal can never re-create an earlier run's topic.
- D10's check means a new seal waits for the earlier run's topic to be gone, whether by product cleanup (a `SUCCEEDED` run) or by a person's manual resolution (any other run).
- Pub/Sub's own 409 stops a duplicate name.

Nothing is retried anywhere.

**Interruption and recovery** use the driver's existing paths. Rows 1 and 2 reapply the same sealed plan (the same topic name); later rows need a new seal (D4):

| Situation | What happens | Recovery |
|---|---|---|
| Stopped before the reservation, or before `execute` started | nothing reserved, or the reservation is released; no approval consumed | apply the same plan again |
| `APPROVALS_SPENT` or `KILL_SWITCH_AFTER_APPROVALS` | nothing created; evidence or a refusal records it | new approvals for the same plan, as for every engine |
| `FAILED_NO_CHANGE` | the plan and approvals are spent | seal a new plan (a new name), get new approvals |
| `PARTIAL_REQUIRES_REVIEW` | the plan is spent; the blueprint is written from what `settle` read | `observe`, then a person reviews and resolves it by hand (below). The product cannot clean it up |
| The process killed after the reservation (SIGKILL, power loss) | the reservation stays, with no evidence | `./alz apply record-recovery` (the `act-run-recovery` gate), after the person reads the sealed name with `observe`; never resumed without new approval |

**Runs that did not succeed: no product cleanup today.** `buildCleanupProposal` refuses any run whose apply did not end `SUCCEEDED` (`OWNERSHIP_AMBIGUOUS`, `src/apply/cleanup-proposal.ts`), and `runCleanup` refuses one too (`RUN_RECORD_MISSING`). So a topic left by a `PARTIAL_REQUIRES_REVIEW` run (a storage-policy or label mismatch, a 409, or an uncertain create that landed) **cannot be removed by the product's cleanup.** It also keeps D10's unit sweep non-empty, so every later seal and apply under the target is refused (`UNIT_NOT_EMPTY`) until it is gone.

- **Who resolves it:** the owner, or a person the owner names as cleanup owner (an owner input of 6481421924). Never an agent.
- **How:** the person reviews the run's records and the topic. If it is to go, they delete that one topic by hand in the DEV project, with their own credentials outside the product's runtime identities, by its exact sealed name only. Then they check its absence:
  - **The run left a blueprint:** they run `./alz apply observe --sealed SEALED_PLAN` again. `observe` accepts any finished run that left a blueprint, whatever its outcome (`observeRun`, `src/apply/observe.ts`), and the observation record is rewritten with the newest reading (`writeObservationRecord`, `src/apply/run-records.ts`). The DISCOVERY read is then the independent absence check.
  - **The run left no blueprint:** `observe` refuses with `RUN_RECORD_MISSING`, so the absence check is the person's own read of the exact topic name, labeled MANUAL.
  - `./alz apply verify-cleanup` is **not** used here: it needs `--proposal`, and such a run never has a cleanup proposal.
- **Evidence:** the hand deletion is recorded as **MANUAL**, a person's action, with who did it, when, and the exact name. The MANUAL note is recorded on the #39 coordination ledger, and in the GCP evidence checklist (`docs/act-pilot-gcp-evidence.md`) once that document exists. No product record type is created for it. It is never presented as product cleanup, never carries a `CleanupEvidence` record or a `cleanupMutation`, and never counts toward the cleanup step of `act:gcp-gcp_api`. Only the independent DISCOVERY read is evidence of absence.

**OPEN (not designed here).** A product cleanup path for runs that did not succeed would be a driver change to `buildCleanupProposal` and `runCleanup`. It changes deletion authority, so it needs its own owner decision under D16 before anyone designs it.

### D15. Independent read-back through `gcp-rest` [REVIEWER, scope part OWNER under D12]

**Decision.**
- The independent observation is `src/observe/gcp-rest.ts`, wired as verifier `GCP_REST` (INT-1a wires it into `VerifierId` and `openReader` for the GCP provider). The engine's `observeGcpApiPlan` is deleted. The engine still reads the topic itself, in `prepare`, `settle` and the cleanup, but those reads are the engine's own and are never the observation of record.
- `check` reads by id; `listTagged` sweeps by unit. Both exist today. Label ownership is the engine's read before a delete, and run ownership is the records'.
- **D11's independent read-back.** The reader learns one more fact for `google_pubsub_topic`, and only when the blueprint entry carries an expected value: `messageStoragePolicy.allowedPersistenceRegions`, compared exactly. A mismatch fails the check (`FAILED` verdict), and a missing field is `UNKNOWN`. The reader change is G1's (with the scope fix below); the blueprint entry's expected-policy field is INT's (`src/observe/blueprint.ts`).

**Required correction (found in this review).** The reader requests `cloud-platform.read-only` for every GET, and its own header lists as UNVERIFIED whether Pub/Sub accepts that scope. #303 states that Pub/Sub refuses it with 403 (the v1 discovery document lists only `cloud-platform` and `pubsub` on `topics.get`). If so, every topic check reads `UNKNOWN` and every observation is `INCONCLUSIVE`, on path 5 as well as path 6.

The reader therefore mints one token per host it reads:
- `pubsub` for `pubsub.googleapis.com`;
- for `cloudasset.googleapis.com`, `cloud-platform.read-only` if Cloud Asset accepts it, otherwise `cloud-platform` (UNVERIFIED GF3).

Each token is used only on its own host. The change belongs to G1, after INT-1a merges, because path 5 needs it too; if INT-1a's reviewed diff already changes the scope, it stays with INT-1a (coordinator default, #39 6481739345). It is part of D12's owner decision, because it is a token scope change.

**Rejected.** Keeping `observeGcpApiPlan` as the observation: the engine would verify its own work, and nothing would be independent.

### D16. Cleanup of the run-owned topic, with verified absence [OWNER: ACCEPTED for the deletion authority and the residual, 6483366237; REVIEWER for the mechanism]

**`openCleanup`:**

- **`prepare`** (async): reads the topic named by the run's sealed change list and blueprint under DISCOVERY. It must exist, carry exactly the unit's labels, and carry the sealed storage policy. Otherwise:
  - absent (404) is `CLEANUP_NO_CHANGES`: already absent, not deleted by this run;
  - a read that fails (401, 403, 429, 5xx, no answer) is `CLEANUP_READ_FAILED`. **A read or authorization failure is never evidence of absence**;
  - present with other labels or another storage policy is `OWNERSHIP_MISMATCH`. **An ownership mismatch blocks deletion**, and the topic is kept.

  Each refusal comes before any approval is consumed. These three codes are the engine's own: thrown from `prepare`, they reach the person through `runCleanup`'s generic catch as `APPLY_FAILED`, with the code inside the message. Mapping them to their own driver refusal codes is the integrator's choice (D17).

  Cleanup is reached only for a run that ended `SUCCEEDED`; any other run has no cleanup proposal (D14, "Runs that did not succeed").
- **`planDestroy(addresses)`**: exactly one address, of the form `google_pubsub_topic.<topicPrefix><12 hex>`, whose project and prefix are the target's. It returns `[{ address, type: "google_pubsub_topic", action: "DELETE" }]`, and the driver's `cleanupScopeProblem` and `protectedDeletionIn` judge it as for every engine.
- **`execute`**: reads `stopWhen()`, mints APPLY's token, reads `stopWhen()` again, and sends one `DELETE` to the exact sealed URL.
- **`settle`**: reads under DISCOVERY, at most `N` reads. "Absent" means a 404 on the read; a failed read is unreadable, never absent.

| `DELETE` answer | Read-back | Outcome | Evidence says |
|---|---|---|---|
| 200 | absent | `SUCCEEDED` | deleted by this run (`deletedByRun: true`) |
| 404 | absent | `SUCCEEDED` | already absent, **not deleted by this run** (`deletedByRun: false`). A 404 never supports "this run deleted it" |
| definite refusal (400, 401, 403, 429) | present and unchanged on every read | `FAILED_NO_CHANGE` | not deleted; topic retained |
| timeout, 5xx or no answer | anything | `PARTIAL_REQUIRES_REVIEW`: reconciliation, **never "no change"** | uncertain; a person reconciles with `verify-cleanup` |
| any | unreadable, or present after a 200 or 404 | `PARTIAL_REQUIRES_REVIEW` | unknown; recorded as such |

`deletedByRun` is a name for the integrator's schema field (D17); the rule is that the evidence never claims a deletion the run did not make.

Then `./alz apply verify-cleanup` reads the id and sweeps the unit under DISCOVERY, independently of the APPLY call, and records the result. **Absence is confirmed only by that independent read.** Whatever is retained (an ownership mismatch, a refused delete) or unknown (an unreadable read, an uncertain delete, an `unexpected` unit topic) is recorded in that leftovers record, and all evidence is kept.

**Nothing else is ever deleted.** Cleanup deletes only the exact topic named by the run's sealed artifact and recorded blueprint, after the target check (D9) and the ownership check. It never deletes by prefix, by label search, or because an inventory listing named something. It never extends to subscriptions (there are none), IAM bindings or any project resource. The one URL is the sealed one, behind the same network gate as the apply. It uses the driver's cleanup proposal, requester signature, approvals, cleanup ledger, authorization checks and kill switch, unchanged.

**Evidence values (new enum members, INT):**
- `mutation: "GCP_PUBSUB_TOPIC_CREATE_OF_SEALED_REQUEST"`;
- `cleanupMutation: "GCP_PUBSUB_TOPIC_DELETE_OF_RUN_TOPIC"`.

**Why [OWNER].**
- The driver refuses a cleanup for an engine without one, stating that "its deletion authority needs its own owner decision". The owner accepted the deletion authority above (the run's one exact topic only) under separate CLEANUP authorization (6483366237).
- The known gap from #303 remains: `topics.delete` takes no etag, so a label change between the `prepare` read and the `DELETE` is not caught. It is narrower now, because the name is run-unique and the window spans one token exchange. The owner accepted this residual with D16.

### D17. Evidence and release wiring [REVIEWER; INT and L7 do it]

| Item | Change | Owner |
|---|---|---|
| `EngineId`, `ENGINE_IDS`, `SPECS` | add `GCP_API`, valid with `GCP` only | INT-2 |
| `ManifestEngine`, `MANIFEST_ENGINES` | add `GCP_API`; no lock file required, as for CDK and Bicep; excluded from `DriverEngine` | INT-2 |
| `PLANNED_PATHS` and `DEV_ONLY_PATHS` | move GCP_API from the first to the second | INT-2 |
| `ApplyEvidence.authority.mutation`, `CleanupEvidence.authority.mutation` | D16's two values | INT-2 |
| `StateDocument.source` and the blueprint | `GCP_API_TOPIC` and `blueprintFromGcpApiTopic`, plus the branch in `keepBlueprint` | INT-2 (`engine-spec.ts`, `driver.ts`, and the mapper in `observe/blueprint.ts`) |
| `VerifierId` and `openReader` | `GCP_REST` for the GCP provider | INT-1a |
| `pilotUnitOf` (`src/apply/unit.ts`) and `DeletionUnitStateRef` (`src/teardown/types.ts`) | a GCP_API-only state reference and backend kind `pubsub`; every other engine's unit id unchanged, pinned by a regression test (D10) | INT-2 |
| `CleanupEvidence` | records whether the run's `DELETE` deleted the topic (D16) | INT-2 |
| Cleanup refusal codes `CLEANUP_NO_CHANGES`, `CLEANUP_READ_FAILED`, `OWNERSHIP_MISMATCH` | reach the person as `APPLY_FAILED` with the code in the message today; their own `ApplyRefusalCode` entries are optional | INT-2 (integrator's choice) |
| `ApplyEvidence` or the blueprint record | names the verified property `messageStoragePolicy.allowedPersistenceRegions` and its sealed value (D11) | INT-2 |
| Blueprint entry expected storage policy | carried for `google_pubsub_topic` entries of GCP_API runs (D11, D15) | INT (`src/observe/blueprint.ts`) |
| GCP reader storage-policy comparison | D15 | G1, with the scope fix |
| `parent` labeling | shown as "owner-declared, not observed" wherever it appears (D9) | INT-2 and G2 |
| `bootstrap/gcp` identity checklist and grants | D12's checklist, the project-scoped Cloud Asset grant, bootstrap-only API enablement, no broad roles | G1 |
| The shared STS exchange (`src/tools/gcp-credentials.ts`) | D20 | INT |
| `gcp-rest` per-host token scope | D15 | G1 after INT-1a, or INT-1a if its diff already has it |
| `ACT_RELEASE_PATHS` | add `{ provider: "GCP", engine: "GCP_API" }`; its gate id is generated as **`act:gcp-gcp_api`** | INT-2 |
| `config/release/scope.json`, `status.json` | the `act:gcp-gcp_api` row, BLOCKED until live evidence exists | L7 with INT-2 |
| `config/acceptance/journeys.json`, `src/release/acceptance.ts`, `src/release/pilot-paths.ts` | D18 | INT-1b |
| Phase E scenario | a GCP discovery `Provider` and mock | INT-1b |
| `docs/act-pilot-gcp-evidence.md` | the evidence checklist and the `./alz` collection commands, per PLAN section 3 | engineering, before acceptance |

The live record (`./alz apply record-live`) then names `cloud: "GCP"` and `engine: "GCP_API"`, and release admission checks it against `act:gcp-gcp_api` like every other path.

### D18. `GCP_API` versus `NATIVE_API` [REVIEWER]

**Finding.** The release code joins a journey row to a path by `row.path === engine`:
- `src/release/pilot-paths.ts` compares `p.engine === report.path`;
- `src/release/status.ts` compares `x.path === path.engine`;
- `src/release/acceptance.ts` compares `record.engine !== row.path`.

With the row named `NATIVE_API` and the engine `GCP_API`, the row would never find its gate, and a live record would never match its row.

**Decision.** One id, **`GCP_API`**, everywhere:
- `REQUIRED_ROWS` and the `journeys.json` row become `{ cloud: "GCP", path: "GCP_API" }`.
- The display word stays "API-native" (`ENGINE_WORDS` keyed by `GCP_API`).
- The tests that name `GCP/NATIVE_API` (`test/readiness-order.test.ts`, `test/deployment-paths-ui.test.tsx`) follow.
- `NATIVE_API` stays only in historical text.

**Rejected.** Renaming the engine to `NATIVE_API`. `GCP_API` is already the id in `contract.ts`, the `bootstrap/gcp` variable and its tests, `docs/act-pilot-bootstrap-gcp.md`, and #303's engine and tests. It would also make the gate `act:gcp-native_api`, unlike the PLAN correction's `act:gcp-gcp_api`.

### D19. What G2 deletes from `gcp-api.ts` [REVIEWER]

**Deleted:**
- the exports `sealGcpApiPlan`, `verifyGcpApiPlan`, `applyGcpApiPlan`, `observeGcpApiPlan` and `cleanupGcpApiPlan`, replaced by the `GCP_API` spec's `plan`, `openApply` and `openCleanup`;
- the parallel signature: the imports of `signRequest`, `verifyRequestSignature` and `requesterKeyRefusal`, `allowlistOf`, the plan's `requesterId` and `request` fields, and the test cases in `test/apply-gcp-api.test.ts` that assert the engine's own `REQUESTER_*` refusals (such as `REQUESTER_KEY_MISMATCH` and `REQUESTER_MISBOUND`, which come from `requesterKeyRefusal` and `verifyRequestSignature`). The driver's tests already cover those refusals;
- the parallel ledger: `ledgerDir`, `ledgerPrivate`, `claim`, `record`, `stateOf`, `LedgerState`, `LEDGER_NOT_PRIVATE`, `ALREADY_APPLIED` and `NOT_RUN_CREATED`;
- the parallel target: `GcpApiTarget` and `GcpApiDeps.target`, replaced by `EngineContext.pinned` and `spec`;
- the parallel kill switch: `GcpApiDeps.killSwitch`, replaced by `control.stopWhen` and the driver's gates;
- `sealNonce` and `SEAL_NONCE`, replaced by the run-unique suffix (D10);
- `CallEvidence` in results: the driver's evidence records outcomes, and call-level detail is not carried.

**Kept and adapted:**
- the request check, narrowed to D7's two keys;
- `callsOf`;
- the network gate (`allowed`, `httpsOn`, `senderFor`);
- the identity check and token exchange (`identityOf`, `bearerFor`, `tokenField`), behind D20;
- `readTopic`, extended to return the storage policy.

`test/apply-gcp-api.test.ts` is rewritten against the spec through the driver (section 5). Its token-leak, network-gate and credential-file cases carry over.

### D20. One token exchange, not two [REVIEWER]

**Finding.** The engine and the reader each implement the STS exchange and the impersonation, and they disagree on the wire format:
- the engine posts JSON with camelCase fields;
- the reader posts form-encoded snake_case fields.

At most one of them is what Google documents for `sts.googleapis.com/v1/token` (UNVERIFIED GF1).

**Decision.** One exchange function, used by both, in the shared `src/tools/gcp-credentials.ts` (the serialized integrator's file) (which already holds `checkCredentialConfiguration` and `readTokenFile` for both). The scope and lifetime stay parameters. Before G2 merges, its request shape is checked against Google's published STS and IAM Credentials references. The owner's live DEV run is what proves it.

## 4. Lane order

1. **This record**: merged (#338), and the owner's decisions are recorded (6483366237). Done.
2. **INT-1a**: merged (#339): the GCP provider spec, `GCP_REST` in `VerifierId`, `canary` types.
3. **INT-1b** (running): D18 and the Phase E scenario.
4. **G1**: the `gcp-rest` scope fix and storage-policy comparison (D15), and the `bootstrap/gcp` identity review with D12's checklist and contract-target template.
5. **INT, the D5 interface change**, in its own PR. No engine behavior changes.
6. **G2**, engine-local (`gcp-api.ts`, its tests and docs): the spec, not yet in `SPECS`. The blueprint mapper, the shared exchange and the unit change are INT's.
7. **INT-2**: `SPECS`, the ids and enums, the contract scope, `pilotUnitOf`, the evidence fields, the release path `act:gcp-gcp_api`; L7 adds its rows.
8. The evidence checklist, then the owner's inputs and the owner's DEV run.

This matches the coordinator's serialized order in 6483366237.

## 5. Tests G2 and INT must add

All of these are SYNTHETIC: a fake for STS, IAM Credentials, Pub/Sub and Cloud Asset, fake identifiers, no network. They prove code paths, never live provider behavior.

**Interface (INT, D5).**
- The Terraform, CDK and Bicep suites pass unchanged.
- A fake engine whose `plan`, `prepare`, `rederive` and `planDestroy` return promises seals, applies and cleans up through the driver.
- A signal that arrives during an awaited `prepare` stops the apply with nothing consumed.

**Positive (G2, through `sealPreview`, `runApply`, `observeRun`, `runCleanup`, `verifyProposalLeftovers`).**
- Seal: one `CREATE` line, the exact derived calls, the canary checked, the requester signature made by the driver.
- Apply to `SUCCEEDED`, with the blueprint written from `stateDocument`.
- An observation of `VERIFIED` through `GCP_REST`.
- A proposal deleting exactly the run's topic, a cleanup to `SUCCEEDED`, and leftovers verified absent.

**Denied.**
- Contract: a request key other than the two, a kind other than `PUBSUB_TOPIC`; a canary type other than `google_pubsub_topic`, a count other than 1, or `retain`; a `backend` other than the sentinel; a `workspace` other than `default`; a bad `topicPrefix`.
- Target hash: a moved `topicPrefix`, `region` or `parent` refuses cleanup (`TARGET_NOT_IN_CONTRACT`).
- A non-DEV target or a missing `enabledEnvironments`.
- An edited artifact: another URL, body, label or storage policy gives `ARTIFACT_TAMPERED` with nothing consumed.
- A topic that already exists at seal or at apply.
- A unit sweep that is not empty, or incomplete, at seal and again at apply. Two plans sealed back to back: once the first one's topic is listed, the second apply is refused in `prepare` with nothing consumed.
- A cleanup `DELETE` answered 404: `SUCCEEDED`, with the evidence recording that the run did not delete the topic.
- A `PARTIAL_REQUIRES_REVIEW` run gets no cleanup proposal (`OWNERSHIP_AMBIGUOUS`), and its topic keeps a later seal refused (`UNIT_NOT_EMPTY`).
- After `APPROVALS_SPENT` or `KILL_SWITCH_AFTER_APPROVALS`, the same sealed plan applies with new approvals, with the same topic name.
- Cleanup `prepare` with a read failure (403, 5xx, no answer) is refused as `CLEANUP_READ_FAILED`, never treated as absent; a cleanup `DELETE` that times out is `PARTIAL_REQUIRES_REVIEW`, never `FAILED_NO_CHANGE`.
- An apply `settle` read that fails is never `FAILED_NO_CHANGE` or `SUCCEEDED`; a present topic with another storage policy is never `SUCCEEDED`.
- A cleanup under a contract whose `topicPrefix`, `region` or `parent` changed is refused (`TARGET_NOT_IN_CONTRACT`), and no request is sent.
- `parent` appears in evidence and reports only with the "owner-declared, not observed" label.
- The topic name in the review bundle is the full sealed name, and `rederive` refuses a plan whose name differs from the sealed one.
- The unit ids of the AWS and Azure Terraform, CDK and Bicep paths are unchanged by the GCP_API unit change.
- Identities: a third identity configured; DISCOVERY and APPLY collapsed; a key file; a service account outside the project.
- A lookalike host, a redirect, or a request to any URL outside the sealed one.
- The module hash changed between seal and apply (`ENGINE_BINARY_CHANGED`).
- A cleanup whose topic's labels changed (`OWNERSHIP_MISMATCH`), a cleanup address outside the prefix or project, and a cleanup of a run that did not succeed.

**Replay.**
- A second apply of the same artifact is refused by the driver's ledger.
- The approvals and the cleanup proposal cannot be reused.
- The engine itself holds no ledger: a test asserts that the module writes no file.

**Interrupted.**
- The kill switch before reservation, after `prepare`, and between the token and the `PUT` (`KILL_SWITCH_AFTER_APPROVALS`).
- A signal during `prepare`.
- A process stop after the reservation, recovered with `record-recovery`.

**Recovery and outcome table (D14).** One test per row: 200 with a matching or a mismatched read-back; 409; definite 4xx with the topic absent or present; 5xx or no answer with the topic present or absent. Each test asserts that the `PUT` is sent exactly once.

**Read-back (D15).** The fake refuses `cloud-platform.read-only` on Pub/Sub and `pubsub` on Cloud Asset. Each host gets only its own token. No token value appears in any record, result or error.

**Module hash (D1).** The constant equals the computed import closure. Any listed file changing changes the hash. A missing file gives `undefined`, refused at seal.

**Release (INT-1b and INT-2).**
- `ACT_RELEASE_PATHS` yields `act:gcp-gcp_api`.
- `journeys.json` has a `GCP/GCP_API` row, and it joins its gate and live record.
- `scope.json` `actPaths` still equals `ACT_RELEASE_PATHS`.
- `test/apply-gcp-api.test.ts`'s "no engine spec exists for GCP_API" assertion flips in INT-2, and only there.

**Selector.** `scripts/qa-affected.mjs` selects the new tests for `gcp-api.ts`, `gcp-rest.ts`, the blueprint mapper and `gcp-credentials.ts`. A fixture loaded from disk, such as the committed `request.json`, gets an explicit ownership rule.

## 6. Migration risk

| Risk | Effect | Mitigation |
|---|---|---|
| D5 touches the seal, apply and cleanup order for every engine | a missed `await` could reorder a gate, or let a step run before its check | own PR, no behavior change, the three engines' suites unchanged, and a fake async engine; reviewed before G2 starts |
| The reader's scope fix (D15) also changes path 5's observation | a path 5 observation that read `UNKNOWN` would start reading `PRESENT` | intended. Coordinated with G1; the fake enforces the accepted scopes |
| Deleting the standalone functions removes #303's tested behavior | regression in token handling or the network gate | those parts are kept (D19), and their tests carry over before the old ones are removed |
| The `NATIVE_API` to `GCP_API` rename (D18) | the console and readiness tests fail, or a row loses its gate | one INT-1b change with the tests that name the row; the matrix check (`checkJourneyMatrix`) catches a missing row |
| The cleanup-classifier bucket list with a sentinel backend | the sentinel misread as a bucket | the list is empty for GCP_API (D9), and the sentinel cannot match a topic name |
| Shared files across INT, G1 and G2 | overlapping edits | each file has one owner at a time (section 4); G2 touches no INT file |
| Two GCP token implementations until D20 lands | one path works live and the other does not | D20 before G2 merges |
| The engine's network reads become part of seal and apply | a slow Google answer stalls a seal | the existing `fetch` client with no retry; a bounded timeout per request is set in G2 and reviewed. It never retries and is never raised to hide a failure |
| No live evidence until the owner's run | SYNTHETIC passes are mistaken for provider qualification | every test and record is labeled SYNTHETIC; `act:gcp-gcp_api` stays BLOCKED until owner-attested live evidence passes admission |

## 7. Facts to verify before G2 merges

Each one is checked against Google's published API reference or discovery document, with no live call, and the result is recorded in G2's PR:

- **GF1:** the request format of `sts.googleapis.com/v1/token`, JSON or form-encoded (D20).
- **GF2:** the OAuth scopes `pubsub.projects.topics.get`, `.create` and `.delete` accept (D12, D15).
- **GF3:** the scopes `cloudasset.searchAllResources` accepts, and its query syntax for labels (D15).
- **GF4:** that `topics.create` takes `messageStoragePolicy` on `PUT` and `topics.get` returns it as sent (D11).
- **GF5:** Cloud Asset Inventory's indexing delay (D10).
- **GF6:** the status and error code of a duplicate `topics.create` (409 `ALREADY_EXISTS`) and of a `DELETE` of an absent topic (404) (D14, D16).
- **GF7:** whether any call on this path, Cloud Asset `searchAllResources` most likely, needs a quota project or `serviceusage.services.use` when made by the impersonated service account. **It may conflict with D12 checklist item 5**, which forbids every `serviceusage.*` permission. If it is needed, the conflict goes back to the owner before bootstrap; it is not resolved by widening a grant silently.
- **GF8:** the scope the STS token exchange must request, and whether `cloud-platform` there is required (D12 item 7, D20).
- **GF9:** that `pubsub.topics.create` alone covers a create carrying `messageStoragePolicy` (D12 item 2; with GF4).
- **GF10:** that `cloudasset.assets.searchAllResources` is supported in custom roles at project level (D12 item 4).
- **GF11:** that `roles/iam.workloadIdentityUser` carries `iam.serviceAccounts.getAccessToken` for federated principals, so no Token Creator role is needed (D12 items 5 and 7).

GF7 to GF11 are checked by lane G1 before bootstrap, and all of GF1 to GF11 before lane G2 merges.

## Decision index

| # | Decision | Mark |
|---|---|---|
| D1 | READY hash: the `IN_PROCESS_MODULE` source-closure hash | REVIEWER |
| D2 | Requester signature: the driver's only | REVIEWER |
| D3 | Once-only ledger: the driver's only | REVIEWER |
| D4 | Dedicated `topicPrefix` field; suffix once at seal; `backend` and `workspace` compatibility values | **OWNER: ACCEPTED** (6483366237) |
| D5 | `plan`, `qualify`, `prepare`, `rederive` and `planDestroy` may return a promise; one INT PR first | REVIEWER |
| D6 | Cleanup through `stateDocument`, the blueprint and the driver's cleanup flow | REVIEWER |
| D7 | Typed request of two keys; every other value derived; the artifact is the exact calls | REVIEWER |
| D8 | Canary type `google_pubsub_topic`, count 1, create only | REVIEWER (the entry is the owner's) |
| D9 | Full target shape and the fields in `pilotTargetSha256`; `parent` owner-declared; no cleanup redirect | **OWNER: ACCEPTED** (6483366237) |
| D10 | Run-unique names; unit per target (GCP_API-only change); unit sweep at seal and again at apply, not a guarantee inside the indexing window | REVIEWER |
| D11 | Storage policy enforced and read back; no data-residency claim | **OWNER: ACCEPTED** (6483366237) |
| D12 | Two identities; project-scoped Cloud Asset search; no runtime API enablement; checklist before bootstrap | **OWNER: ACCEPTED** (6483366237) |
| D13 | What the preview proves | REVIEWER |
| D14 | Execution, outcome table, idempotency, recovery | REVIEWER |
| D15 | `gcp-rest` is the independent read-back; per-host token scope; storage-policy comparison | REVIEWER (the scope accepted with D12) |
| D16 | Delete only the run's exact topic; independent absence; no-etag residual | **OWNER: ACCEPTED** (authority and residual, 6483366237), REVIEWER (mechanism) |
| D17 | Evidence and release wiring, `act:gcp-gcp_api` | REVIEWER |
| D18 | `GCP_API` everywhere; "API-native" as the display word | REVIEWER |
| D19 | Deletions from `gcp-api.ts` | REVIEWER |
| D20 | One token exchange implementation | REVIEWER |

None of these decisions enables ACT, runs anything, spends money or changes IAM. The owner's acceptance (6483366237) authorizes no live execution or spending, and ACT stays DISABLED until a reviewed contract with `authorize` exists. Lane G2 starts in the serialized order of section 4, after the D5 interface change has merged.
