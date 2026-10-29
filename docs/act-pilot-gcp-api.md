# ACT pilot path 6: GCP API-native provisioning (`GCP_API`)

Status: engineering only. **ACT = DISABLED.** The repository ships no pilot contract: the contract's `authorize` entry is the switch, and there is no pin. Nothing in this path has run against Google Cloud. All evidence is **SYNTHETIC** or **EMULATED**.

The engine is **registered and admitted for DEV only** (INT-2, owner decision 6483993252 on #39). `GCP_API` is in `SPECS` (`src/apply/engine-spec.ts`) and in `DEV_ONLY_PATHS` (`src/apply/contract.ts`), GCP / GCP_API is a pilot combination with its own mutation, and its release gate is `act:gcp-gcp_api`, BLOCKED until the owner's live run. Registration is not readiness, and ACT stays DISABLED until the owner's reviewed contract authorizes it ("What INT-2 added" below).

- **Design:** `docs/act-pilot-gcp-api-driver.md` (D1 to D20). The owner accepted D4, D9, D11, D12 and D16 on #39 (6483366237).
- **Code:** `src/apply/engines/gcp-api.ts` (lane G2). The shared prerequisites came from INT-5 (#356):
  - the target shape, `src/apply/gcp-api-target.ts`;
  - the GCP_API unit, `src/apply/unit.ts`;
  - the blueprint mapper, `blueprintFromGcpApiTopic` in `src/observe/blueprint.ts`;
  - the one token exchange, `src/tools/gcp-credentials.ts`.
- **Tests:**
  - `test/apply-gcp-api.test.ts` (SYNTHETIC; in-memory emulator);
  - `test/apply-emulated-gcp-api.test.ts` (EMULATED; loopback emulator);
  - the emulator itself: `test/helpers/gcp-api-emulator.ts`.
- **Typed-request example:** `qualification/gcp/act-dev1-canary-api/request.json`.

## What the engine is

Path 6 is one more `EngineSpec` on the shared pilot driver (`src/apply/driver.ts`). The driver owns everything that is not specific to this engine:

- the contract, the kill switch, the target and its hash;
- the requester signature (D2) and the approvals;
- the once-only ledger (D3) and the evidence;
- the blueprint, the independent observation and the cleanup proposal.

The engine owns:

- the typed request check;
- the derived REST calls;
- the network gate: its three Google hosts (STS, IAM Credentials, Pub/Sub) over https only, the sealed topic URL only, and one method per sender (a read sends only `GET`, the create only `PUT`, the delete only `DELETE`; `PATCH`, `POST` to Pub/Sub, or a method another sender owns is refused; #357 review N2);
- the workload identity federation token exchange, through the shared one (D20);
- its own reads of the run's topic.

**What was removed (D19).** These are gone from the engine:

- the five standalone functions of #303 (`sealGcpApiPlan`, `verifyGcpApiPlan`, `applyGcpApiPlan`, `observeGcpApiPlan`, `cleanupGcpApiPlan`);
- its own requester signature, ledger, target, kill switch and `sealNonce`;
- its per-call evidence.

The engine writes no file. Tokens live in memory for one call.

The workload is exactly one Pub/Sub topic. It is created once, with the run's unit labels and the contract region's storage policy.

## The request, the target and the name

**The request (D7)** is the project's one file, `request.json`:

```json
{ "schemaVersion": 1, "kind": "PUBSUB_TOPIC" }
```

| Refusal | When |
|---|---|
| `FIELD_NOT_ALLOWED` | any other key |
| `KIND_NOT_ALLOWED` | any other kind |
| `REQUEST_INVALID` | any other schema version, or not a JSON object |
| `PROJECT_NOT_ALLOWED` | the project holds any other file |
| `ENGINE_VERSION_NOT_SUPPORTED` | the manifest's engine version is not `gcp-api-1` |

**Everything else is derived.** The requester cannot ask for anything the contract does not already say.

**The target (D9)** is the shared `GCP_API_TARGET`. It holds:

- `projectId` and `region` (the GCP provider's account fields);
- `parent`, which is optional;
- `backend`, exactly `GCP_API_NO_STATE`;
- `workspace`, exactly `default`;
- `topicPrefix`, matching `^alz-[a-z0-9-]{1,40}-$`;
- `canary`.

The engine checks the target again, and refuses a mismatch as `TARGET_NOT_IN_CONTRACT`. `parent` is never read. Wherever this path shows it, it is labeled **owner-declared, not observed**.

**The name (D4, D10).** At seal, the engine draws 6 random bytes. The topic id is `topicPrefix` followed by those 12 hex characters.

- The suffix is inside the artifact, so each approver signs one exact topic.
- `rederive` takes the suffix from the sealed artifact. Nothing on apply, retry or cleanup draws a new one.
- A new seal is a new name.

**The unit (D10)** is the product's, from `pilotUnitOf` with engine `GCP_API`: one unit per contract target. The labels are exactly its three tags: `alz-managed-by` = `alz`, `alz-unit`, and `alz-build`.

## The artifact and what approvers see (D7, D13)

The sealed artifact is the canonical JSON of the derived values and the exact three calls:

```text
{ schemaVersion: 1, kind: "GCP_API_PUBSUB_TOPIC", projectId, topicId, labels,
  messageStoragePolicy: { allowedPersistenceRegions: [region] }, precondition: "ABSENT",
  create:   { method: "PUT",    url: "https://pubsub.googleapis.com/v1/projects/<p>/topics/<t>", body: { labels, messageStoragePolicy } },
  readBack: { method: "GET",    url: <same> },
  cleanup:  { method: "DELETE", url: <same> } }
```

**The change list is one line:** `google_pubsub_topic.<full topic id>`, type `google_pubsub_topic`, action `CREATE`.

**The canary (D8).** The canary judge runs at seal and again in `rederive`. The owner's entry must be exactly `{ "type": "google_pubsub_topic", "count": 1 }`. `canaryTypeOk` accepts that one type and nothing else: no wildcard, no pattern, no Cloud Asset name.

**Re-derivation.** `rederive` derives every byte again from the contract target, the run's unit and the sealed suffix. Anything not byte-identical is `ARTIFACT_TAMPERED`, for example:

- another URL, method, body field, label or storage policy;
- an extra call;
- a topic outside the prefix.

A plan renamed consistently to another suffix derives its own change list. The driver's comparison with the sealed change list refuses it.

**What the preview proves (D13).**

1. The request is the allowlisted kind with no other field, and every derived value comes from the reviewed contract.
2. The change is one `CREATE` of `google_pubsub_topic`, within the canary.
3. Under DISCOVERY, the exact topic reads absent (`GET` gives 404), and the unit sweep is complete and empty.
4. Both identities are configured, separate and of the target project. DISCOVERY's token was minted and used. APPLY makes no call at seal.
5. The calls:
   - the review bundle shows the full topic name and the unit's tags;
   - the seal notice states the exact URL form, `https://pubsub.googleapis.com/v1/projects/<project>/topics/<that topic>`, and the storage-policy property.

   The literal artifact bytes are not in the review bundle (see "What INT-2 added", optional items).

**What the preview does not prove:**

- that APPLY holds `pubsub.topics.create`;
- that an organization policy accepts the region;
- that quota is available.

Each of these can only fail as a definite refusal of the one `PUT`.

## Identities and scopes (D12, D15)

There are two runtime identities, **DISCOVERY** and **APPLY**. They are distinct, and use workload identity federation only. There is no STATE, STATE_WRITE or CHANGESET on this path.

Each identity's variables are path 5's:

- `ALZ_<IDENTITY>_GOOGLE_APPLICATION_CREDENTIALS`: a WIF file source;
- `ALZ_<IDENTITY>_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT`: a service account of the target project.

**The driver checks them** with `checkApplyIdentities`, `verifyIdentityTargets`, the delivered-token checks for the `gcp-api` delivery path, and `GCP.ambientRefusal`. Any other identity configured is refused.

**The engine checks them again** before any token request. It refuses these as `IDENTITY_NOT_CONFIGURED`:

- a key file;
- a configuration that carries its own impersonation;
- a gcloud, metadata or other-cloud variable on an identity;
- a service account outside the project.

Two identities with the same service account, configuration or token file are refused as `IDENTITY_COLLAPSED`.

| Token | Scope | Used on |
|---|---|---|
| the STS exchange (the federated token) | `cloud-platform` (GF8) | `iamcredentials.googleapis.com` only |
| DISCOVERY's and APPLY's Pub/Sub tokens | `pubsub` (GF2) | `pubsub.googleapis.com` only |
| DISCOVERY's Cloud Asset token (minted by the GCP reader, D15) | `cloud-platform` (GF3) | `cloudasset.googleapis.com` only |

**Read-only rests on IAM, not on the OAuth scope.**

- DISCOVERY holds `pubsub.topics.get` and the project-scoped `cloudasset.assets.searchAllResources`.
- APPLY holds `pubsub.topics.create` and `pubsub.topics.delete`.

These grants are the owner's bootstrap (`bootstrap/gcp`, `docs/act-pilot-bootstrap-gcp.md`). The emulator enforces the same custom roles: the tests show that DISCOVERY only sends `GET` and APPLY only sends `PUT` and `DELETE`.

## Network boundary

Every request of the engine passes one gate (`allowedRequest`) before it exists. Only these pass:

- a `POST` to exactly `https://sts.googleapis.com/v1/token`;
- a `POST` to a `generateAccessToken` URL on `iamcredentials.googleapis.com`;
- a `GET`, `PUT` or `DELETE` to exactly the run's sealed topic URL on `pubsub.googleapis.com`.

The URL must use https, with no port, userinfo, query or fragment, and a path the parser leaves as written.

The unit sweep goes through the GCP reader (`src/observe/gcp-rest.ts`), which reads `cloudasset.googleapis.com` behind its own gate.

The production client is `fetch` with `redirect: "error"`. Each request is bounded at **30 seconds** (`REQUEST_TIMEOUT_MS`). A request past the bound, like any failure, is a status of 0: no answer. **Nothing is retried.**

## Seal

`plan` runs these steps in order:

1. the request, the target and the unit are checked;
2. both identities' configurations are checked;
3. the suffix is drawn;
4. the artifact and the change list are derived;
5. the canary is judged;
6. under DISCOVERY, the topic must read absent;
7. the unit sweep must be complete and empty.

| Refusal | Meaning |
|---|---|
| `TOPIC_EXISTS` | the topic reads present |
| `UNIT_NOT_EMPTY` | anything is listed under the unit |
| `UNIT_LISTING_INCOMPLETE` | the listing failed or did not finish |
| a read refusal, such as `ACCESS_DENIED_PUBSUB_HTTP_403` | an unreadable topic, never absence |

## Apply (D14)

`runApply` runs its gates in its usual order. The engine's steps:

1. **`prepare`.** Checks the request, the target, the unit and the identities. Then runs **the second unit sweep** (D10), before any approval is consumed.
2. **`rederive`.** The byte-for-byte re-derivation and the canary. Then the sealed topic's own DISCOVERY `GET`:
   - present is `PLAN_STALE`;
   - unreadable is its read refusal.

   **Placement note.** D14 names `prepare` for this read. `EngineApplyRun.prepare` receives only the snapshot path, and the suffix is in the artifact, which first reaches the engine in `rederive`. Both steps are awaited and come before consumption. The refusal and its "nothing consumed" are the same.
3. **`execute`.**
   1. `control.stopWhen()` is read; on, the result is `notStarted` (the driver's `KILL_SWITCH_AFTER_APPROVALS`).
   2. APPLY's token is minted. A failure throws before any Pub/Sub request: the driver's `APPROVALS_SPENT`.
   3. `stopWhen()` is read again.
   4. The one `PUT` is sent exactly once. From the `PUT` on, nothing throws.
4. **`settle`.** At most 3 DISCOVERY reads, 2 seconds apart, judged by positive evidence only.

| `PUT` answer | Read-back | Outcome |
|---|---|---|
| 200 | present, the sealed name, labels and storage policy | `SUCCEEDED` |
| 200 | anything else (other labels or policy, no policy, absent, unreadable) | `PARTIAL_REQUIRES_REVIEW` |
| 409 | anything | `PARTIAL_REQUIRES_REVIEW` |
| 400, 401, 403, 404, 429 | absent (404) on every read | `FAILED_NO_CHANGE` |
| 400, 401, 403, 404, 429 | present or unreadable | `PARTIAL_REQUIRES_REVIEW` |
| 5xx, no answer, or any other status (408, for example) | present with the sealed labels and policy | `SUCCEEDED` |
| 5xx, no answer, or any other status | anything else | `PARTIAL_REQUIRES_REVIEW` |

- **Absent** means the `GET` answered 404. A read that fails is unreadable, never absent.
- There is **no `KILLED`** outcome.
- The tests send exactly one `PUT` per row.

**`stateDocument`** returns what `settle` read, as `{ name, labels }`, with source `GCP_API_TOPIC`. The driver maps it with `blueprintFromGcpApiTopic`.

**Recovery.**

| Situation | Recovery |
|---|---|
| Stopped before `execute` started, `APPROVALS_SPENT`, or `KILL_SWITCH_AFTER_APPROVALS` | The driver gives the reservation back. The same sealed plan, with the same name, applies with new approvals. |
| `FAILED_NO_CHANGE` or `PARTIAL_REQUIRES_REVIEW` | A new seal, so a new name. |
| A process killed after the `PUT` | Never resumed. The same plan's sweep or its own `GET` refuses it (`UNIT_NOT_EMPTY` or `PLAN_STALE`). `./alz apply record-recovery` records it (generic through `engineOf`). |

### Runs that did not succeed

- The driver makes no cleanup proposal for a run that did not end `SUCCEEDED`. `buildCleanupProposal` refuses it with `OWNERSHIP_AMBIGUOUS` (asserted in the EMULATED test).
- Its topic keeps every later seal and apply under the target refused (`UNIT_NOT_EMPTY`).
- **Who resolves it:** the owner, or a cleanup owner the owner names. Never an agent.
- **How:** that person deletes the one topic by its exact sealed name, with their own credentials, outside the product. Then they run `./alz apply observe --sealed SEALED_PLAN` again. Its DISCOVERY read is the independent absence check, and the verdict `FAILED` (the planned topic is absent) is the expected result.
- **Evidence:** the hand deletion is recorded as MANUAL on #39 and in `docs/act-pilot-gcp-evidence.md`. It is never product cleanup.

## Cleanup (D16)

Cleanup is the driver's `runCleanup`. It is reached only for a run that ended `SUCCEEDED`, with its proposal, requester, cleanup approvals and ledger.

**`planDestroy`.** It accepts exactly one address, `google_pubsub_topic.<topicPrefix><12 hex>`, in the target's project. Then it reads the topic under DISCOVERY. Every refusal comes before any approval is consumed.

| Refusal | When |
|---|---|
| `CLEANUP_ADDRESSES_INVALID` | more than one address, or none |
| `CLEANUP_ADDRESS_NOT_IN_CONTRACT` | an address outside the prefix or project |
| `CLEANUP_NO_CHANGES` | absent: already absent, not deleted by this run |
| `CLEANUP_READ_FAILED` | a read that fails (401, 403, 429, 5xx, no answer). **A read or authorization failure is never absence.** |
| `OWNERSHIP_MISMATCH` | present with other labels than the unit's, or another storage policy. The topic is kept. |

The driver then applies `protectedDeletionIn` and `cleanupScopeProblem`, as for every engine.

**Placement note.** D16 names `prepare` for the read. `EngineCleanupRun.prepare` does not receive the addresses, so the read runs in `planDestroy`, which is also awaited and before consumption.

**`execute`.**

1. `stopWhen()` is read.
2. APPLY's token is minted.
3. `stopWhen()` is read again.
4. One `DELETE` of the exact sealed URL is sent, once.

**`settle`.** At most 3 DISCOVERY reads.

| `DELETE` answer | Read-back | Outcome | `deletedByRun()` |
|---|---|---|---|
| 200 | absent | `SUCCEEDED` | `true` |
| 404 | absent | `SUCCEEDED` | `false`: already absent, **not deleted by this run** |
| 400, 401, 403, 429 | present and unchanged on every read | `FAILED_NO_CHANGE` | undefined |
| 400, 401, 403, 429 | anything else | `PARTIAL_REQUIRES_REVIEW` | undefined |
| timeout, 5xx, no answer, any other status | anything | `PARTIAL_REQUIRES_REVIEW`, never "no change" | undefined |
| 200 or 404 | present or unreadable | `PARTIAL_REQUIRES_REVIEW` | undefined |

Then `./alz apply verify-cleanup` reads the id and sweeps the unit under DISCOVERY, independently of the APPLY call. **Absence is confirmed only by that read.**

**Nothing else is ever deleted.** Cleanup never deletes:

- by prefix, by label search, or because an inventory listing named something;
- a subscription, an IAM binding or any project resource.

**Residual (accepted with D16):** `topics.delete` takes no etag, so a label change between the read and the `DELETE` is not caught.

## Observation (D15)

The observation of record is the GCP reader, `GCP_REST` (`src/observe/gcp-rest.ts`), on the blueprint the run left. It checks:

- existence by id;
- the sweep by unit;
- for a `google_pubsub_topic`, `messageStoragePolicy.allowedPersistenceRegions` against the contract region. A mismatch is `misplaced`, and the verdict is `FAILED`.

The engine has no observe step. Its own reads in `rederive`, `settle` and `planDestroy` are never the observation of record.

**D11 (owner-accepted).** The create sets exactly one Pub/Sub property, `messageStoragePolicy.allowedPersistenceRegions` = `[<contract region>]`, and it is read back. **This is not a data-residency claim.** It says nothing about the topic as a whole, the project, or Google's processing. The canary publishes nothing, has no subscriptions and processes no payloads.

## The READY hash (D1)

`binarySha256` is the SHA-256 of the canonical JSON of:

```text
{ kind: "IN_PROCESS_MODULE", engine: "GCP_API", files: [ { path, sha256 } ] }
```

- `files` are the engine module and its transitive in-repository runtime imports, listed in `GCP_API_MODULE_FILES`, sorted by path, as loaded: `src/**.ts` under tsx, `dist/**.js` in the image.
- A test computes the real import closure (esbuild's emit, which drops type-only imports) and fails when the list differs.
- Any listed file changing changes the hash.
- A missing file gives `undefined`, which the driver refuses at seal and as `ENGINE_BINARY_CHANGED` at apply.
- `executables` is empty.

## Refusal shapes (D20)

Each refusal from an HTTP answer names the step and the status, never the body. The form is `<CLASS>_<STEP>_HTTP_<status>`, or `<CLASS>_<STEP>_NO_ANSWER`. Examples:

- `CREDENTIALS_STS_HTTP_400`;
- `CREDENTIALS_IAM_CREDENTIALS_HTTP_403`;
- `ACCESS_DENIED_PUBSUB_HTTP_403`;
- `THROTTLED_PUBSUB_HTTP_429`;
- `HTTP_ERROR_STS_NO_ANSWER`.

Other cases:

- An input the shared exchange refused before sending (`invalidInput`) is `IDENTITY_NOT_CONFIGURED`, never a refused host. The reader maps the same case to `CREDENTIALS`. Both lines are pinned by tests.
- The gate's refusal is `HOST_REFUSED`.
- **A first-run `CREDENTIALS_STS_HTTP_400`** before any resource is read is the open GF1 question first, not a bad identity (`docs/act-pilot-gcp-evidence.md`). The owner widens no grant for it.

## Residual risks, stated plainly

- **Cloud Asset is eventually consistent (GF5).** Neither sweep sees a topic created inside the indexing window. Two applies inside that window can both create a topic, so two canary topics of one target can briefly coexist; a test shows it. Each topic has its run-unique name and its own run's records. Once indexed, each run's observation lists the other's topic as `unexpected` and fails. Closing the window would need a per-target lock in the driver's ledger, which does not exist.
- **No etag on `topics.delete`** (D16, owner-accepted).
- **DISCOVERY's Cloud Asset visibility is project-wide** (D12, owner-accepted): it sees metadata of every indexed resource in the DEV project, not only topics.

## Google API facts (GF1 to GF11)

Checked on 2026-10-29 against Google's published discovery documents, protos, client libraries and actions, read offline from GitHub. **No Google API endpoint was called.**

- `docs.cloud.google.com` was unreachable from the session, and `cloud.google.com` redirects there.
- The sources, with the SHA-256 prefix of the copy read:
  - Pub/Sub `v1` discovery, revision 20261013 (`e33a6754`), `https://raw.githubusercontent.com/googleapis/google-api-go-client/main/pubsub/v1/pubsub-api.json`;
  - Cloud Asset `v1` discovery, revision 20261017 (`68f965b7`), `.../cloudasset/v1/cloudasset-api.json`;
  - STS `v1` discovery, revision 20261014 (`6038aaf6`), `.../sts/v1/sts-api.json`;
  - IAM Credentials `v1` discovery, revision 20260630 (`90d7239b`), `.../iamcredentials/v1/iamcredentials-api.json`;
  - `googleapis/googleapis` `google/pubsub/v1/pubsub.proto` (`fa9b72b7`) and `google/rpc/code.proto` (`83a63185`);
  - `googleapis/google-cloud-go` `pubsub/topic.go` (`45899631`) and `pubsub/pstest/fake.go` (`b33f6574`);
  - `google-github-actions/auth` `README.md` (`9bba6d0b`).

**VERIFIED** means a published source states it. **UNVERIFIED-OWNER-LIVE** means only the owner's live DEV run can show it. Each such row says how the product reports it, failing closed.

| Fact | Status | Source and exact text, or what the live run shows |
|---|---|---|
| **GF1** STS request format | UNVERIFIED-OWNER-LIVE | The STS discovery `sts.token` describes a JSON body of camelCase fields. Google's Node.js auth library sends a form with snake_case names, and so does the shared exchange. **Live:** a rejection is HTTP 400 at STS, reported as `CREDENTIALS_STS_HTTP_400` before any resource is read. The owner treats it as GF1 and widens no grant. |
| **GF2** Pub/Sub scopes | VERIFIED | Pub/Sub discovery, `projects.topics.create` (`PUT v1/{+name}`), `.get` and `.delete`: `"scopes": ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/pubsub"]`. `cloud-platform.read-only` is not listed. The engine requests `pubsub`. |
| **GF3** Cloud Asset scope | VERIFIED | Cloud Asset discovery, `searchAllResources` (`GET v1/{+scope}:searchAllResources`): `"scopes": ["https://www.googleapis.com/auth/cloud-platform"]`. The reader requests exactly that. |
| **GF3** label query syntax | FIXED IN CODE (INT-2); the live run confirms | The `query` description documents labels as `labels.env:prod` ("have a label `env` and its value is `prod`") and `labels.env:*`. The `=` form is shown only for `name=Important`. The reader (`src/observe/gcp-rest.ts`) now sends the documented form, `labels.alz-unit:<unit>`. `:` matches tokens, not whole values, so the reader also checks each result's own `labels`: a result whose `alz-unit` label is exactly the unit is listed, one with another value is left out, and one that reports no labels makes the listing incomplete, never "nothing here" (`test/observe-gcp.test.ts`, "GF3"). This also fixes path 5, which shares the reader. **Live:** the owner's first run confirms the syntax. If Google refuses it (400), the listing fails, the seal is refused `UNIT_LISTING_INCOMPLETE`, and observations read `INCONCLUSIVE`. Nothing is created, and no grant is widened. |
| **GF4** `messageStoragePolicy` on create | VERIFIED for the shape | Pub/Sub discovery: `create` request and response `{"$ref": "Topic"}`. `Topic.messageStoragePolicy`: "Optional. Policy constraining the set of Google Cloud Platform regions where messages published to the topic may be stored. If not present, then no constraints are in effect." `MessageStoragePolicy.allowedPersistenceRegions`: "A list of IDs of Google Cloud regions where messages that are published to the topic may be persisted in storage." `get` returns `Topic`. |
| **GF4** read back as sent | UNVERIFIED-OWNER-LIVE | No source says the service returns the list exactly as sent; an organization policy could change it. **Live:** any other value is never `SUCCEEDED`. It is `PARTIAL_REQUIRES_REVIEW`, with no product cleanup, and the person resolves it by hand. |
| **GF5** Cloud Asset indexing delay | UNVERIFIED-OWNER-LIVE | No source gives it. **Live:** shown only by timing; the residual above is stated. Observe's sweep positive control (#358 review N2) depends on it ending: until the sweep lists the run's own topic, the observation reads `INCONCLUSIVE`, never `VERIFIED`, and the owner observes again (`docs/act-pilot-gcp-evidence.md`, F7). A live query that never matches leaves path 6 (and path 5) `INCONCLUSIVE` indefinitely: that is GF3's fail-closed signal, not indexing delay, and `verify-cleanup` then records "no strays" `UNPROVEN` (#359 review N1). |
| **GF6** delete of an absent topic | VERIFIED | `pubsub.proto` `DeleteTopic` and Pub/Sub discovery `delete`: "Deletes the topic with the given name. Returns `NOT_FOUND` if the topic does not exist." `code.proto`: `NOT_FOUND = 5`, "HTTP Mapping: 404 Not Found". |
| **GF6** duplicate create | UNVERIFIED-OWNER-LIVE | The Pub/Sub reference does not state the code. Google's Go client: "If the topic already exists an error will be returned." Google's own fake (`pstest`) returns `codes.AlreadyExists`, and `code.proto` maps `ALREADY_EXISTS = 6` to "HTTP Mapping: 409 Conflict". **Live:** a 409 is `PARTIAL_REQUIRES_REVIEW`. Any other definite 4xx with the topic present is also `PARTIAL_REQUIRES_REVIEW`. The run-unique name makes a duplicate unexpected. |
| **GF7** quota project or `serviceusage.services.use` | UNVERIFIED-OWNER-LIVE | No source read states it for an impersonated service account. **Live:** if Cloud Asset needs it, the search answers 403. The seal is `UNIT_LISTING_INCOMPLETE`, and nothing is created. The conflict with D12 item 5 goes to the owner before bootstrap; no grant is widened silently. |
| **GF8** the exchange's scope | VERIFIED | STS discovery, `scope`: "The OAuth 2.0 scopes to include on the resulting access token ... Required when exchanging an external credential for a Google access token." IAM Credentials discovery, `generateAccessToken`: `"scopes": ["https://www.googleapis.com/auth/cloud-platform"]`. The federated token is used only there, so the exchange asks for `cloud-platform`. |
| **GF9** `pubsub.topics.create` covers a create with `messageStoragePolicy` | UNVERIFIED-OWNER-LIVE | The IAM permission reference was unreachable. **Live:** a missing permission is a 403 on the `PUT`. With the topic absent on every read, the result is `FAILED_NO_CHANGE`. |
| **GF10** `cloudasset.assets.searchAllResources` | VERIFIED that it is the permission; UNVERIFIED-OWNER-LIVE for custom roles | Cloud Asset discovery: "The caller must be granted the `cloudasset.assets.searchAllResources` permission on the desired scope, otherwise the request will be rejected." Whether a project-level custom role supports it is in the unreachable custom-roles reference. **Live:** shown at bootstrap, when the owner creates the role, before any run. |
| **GF11** `roles/iam.workloadIdentityUser` suffices for access tokens | VERIFIED (functional) | `google-github-actions/auth` README: "To generate OAuth 2.0 access tokens or ID tokens, you _must_ provide a service account email, and the Workload Identity Pool must have `roles/iam.workloadIdentityUser` permissions on the target Google Cloud Service Account." Token Creator is named only for Domain-Wide Delegation: "you must grant the external identity ("principalSet") `roles/iam.serviceAccountTokenCreator` in addition to `roles/iam.workloadIdentityUser`. The default Workload Identity setup will only grant the latter role." The role's exact permission list was not read. **Live:** a refusal is `CREDENTIALS_IAM_CREDENTIALS_HTTP_403`, before any resource call. |

## Evidence

| Evidence | Mode | Where |
|---|---|---|
| The spec's facts, D1 (closure list, preimage, a changed or missing file), D7 (request, artifact, every tampering), D4, D8, D9, D10 (both sweeps, back-to-back plans, the indexing-window residual), every D14 row with one `PUT`, the kill switch twice, `APPROVALS_SPENT`, the process killed after the `PUT`, D16 (every refusal and every row with one `DELETE`), D12 (identities, collapse, scopes, custom roles), D15 (`GCP_REST`: `VERIFIED`, and `FAILED` for another policy), D19, D20, the network gate, no file written, no token leaked | SYNTHETIC | `test/apply-gcp-api.test.ts`, with the in-memory emulator |
| The whole path through the real driver with a reviewed contract the product loads: `sealPreview`, `runApply` (evidence with this path's mutation and the verified storage policy, the `GCP_API_TOPIC` blueprint), `observeRun` through `GCP_REST`, `buildCleanupProposal` and `signCleanupProposal`, `runCleanup` (`deletedByRun: true`), `verifyProposalLeftovers`; the ledger and approval reuse refused; the kill switch after consumption; a signal during APPLY's token exchange (#357 review N1, apply and cleanup); the run that did not succeed (`OWNERSHIP_AMBIGUOUS`, `UNIT_NOT_EMPTY`, the hand deletion, observe again `FAILED`) | EMULATED | `test/apply-emulated-gcp-api.test.ts`, over loopback HTTP |
| Live STS exchange, impersonation, which principal Google sees, real Pub/Sub and Cloud Asset answers, GF1 and GF3 to GF11 where UNVERIFIED-OWNER-LIVE | **not run** | the owner's supervised DEV run (`docs/act-pilot-gcp-evidence.md`) |

The EMULATED test runs the registered spec through the real driver; only the spec's HTTP client is the emulator's, and its qualification evidence is forged for the emulator (no person attests an emulator run). No step of the driver is re-implemented in the test.

## What INT-2 added

- **Registration:** `GCP_API` in `EngineId` and `SPECS`, valid with GCP only; out of `PLANNED_PATHS` (now empty) and in `DEV_ONLY_PATHS`; the GCP/GCP_API admission combination with `GCP_PUBSUB_TOPIC_CREATE_OF_SEALED_REQUEST`; the release gate `act:gcp-gcp_api` (BLOCKED), its scope and status rows and its journey row; the registration assertion in `test/apply-gcp-api.test.ts` flipped.
- **Evidence:** `ApplyEvidence.authority.mutation` gains `GCP_PUBSUB_TOPIC_CREATE_OF_SEALED_REQUEST` and `CleanupEvidence.authority.mutation` gains `GCP_PUBSUB_TOPIC_DELETE_OF_RUN_TOPIC`; `CleanupEvidence.deletedByRun` comes from the run's `deletedByRun()`; a SUCCEEDED apply's evidence names `verifiedProperty` `messageStoragePolicy.allowedPersistenceRegions` with its sealed value (D11), and only when `settle` read it back as sealed.
- **Blueprint:** `StateDocument.source` gains `GCP_API_TOPIC`, and `keepBlueprint` maps it with `blueprintFromGcpApiTopic` and the place `{ project }`.
- **The run's unit:** the seal's `pilotUnitOf` names the engine, and the driver passes the sealed plan's `unit` into `openApply` and `openCleanup` (seal, qualify, apply and cleanup).
- **Through `engineOf`:** `buildCleanupProposal` (`targetMoved`), `record-recovery`, `record-live` and the lifecycle report reach the spec generically; `gcpBackendBuckets` returns no bucket for GCP_API (D9); the lifecycle report accepts GCP_API only under `act:gcp-gcp_api`.
- **#357 review follow-ups:** N1, the driver's interrupt stops an in-process engine at its stop points (`APPROVALS_SPENT`, nothing sent); N2, each sender is bound to one method (GET reads, PUT creates, DELETE deletes); N3, the EMULATED test runs the real driver; N4, D14's table names 401.
- **GF3:** the reader sends `labels.alz-unit:<unit>` with an exact client-side label check (above).

**Optional, not done (left for a later change):**

- a `ToolName` for the engine's result (it uses `gcp_pubsub_topic` by cast);
- the three cleanup codes as their own `ApplyRefusalCode` entries;
- showing the sealed calls verbatim in the CLI's seal and approve screens.
