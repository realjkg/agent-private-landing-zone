# ACT pilot path 6: GCP API-native provisioning (`GCP_API`)

Status: engineering only. **ACT = DISABLED**, the repository ships no pilot contract (the contract's `authorize` entry is the switch; there is no pin), and nothing in this path has run against Google Cloud. All evidence is **SYNTHETIC**. The engine is not admitted: `src/apply/contract.ts` names GCP API-native only as a planned path, so admission refuses a contract that names it with `NOT_IMPLEMENTED`, and nothing in the product can reach the engine. The authorization lane admits it later, under the same gates as every path.

Owner decision 6443352284 names six paths for the narrow ACT-DEV release. The coordinator default in 6443800275 picks the engine for path 6: a small typed request engine, chosen over Infrastructure Manager, which is Terraform underneath and would duplicate path 5.

- Code: `src/apply/engines/gcp-api.ts`
- Tests: `test/apply-gcp-api.test.ts`

## Minimal workload

The workload is one labeled Pub/Sub topic in the DEV project. Pub/Sub topic (`PUBSUB_TOPIC`) is the only kind the engine allows. Any other kind is refused as `KIND_NOT_ALLOWED`, at seal and again at apply.

## The request document and the sealed plan

The requester supplies exactly four fields:

```json
{ "kind": "PUBSUB_TOPIC", "projectId": "<DEV project>", "topicId": "alz-<name>",
  "labels": { "alz-managed-by": "alz", "alz-unit": "alzu-<20 hex>", "alz-build": "<build id>" } }
```

Each field is checked as follows.

| Field | Rule | Refusal |
|---|---|---|
| any other field | not allowed (no `messageStoragePolicy`, `kmsKeyName`, `schemaSettings`, retention, and so on) | `FIELD_NOT_ALLOWED` |
| `projectId` | a GCP project id, equal to the contract's project for this environment | `PROJECT_NOT_IN_CONTRACT` |
| `topicId` | `alz-` prefix, lowercase letters, digits and hyphens, at most 64 characters, so no id needs escaping in a URL path | `TOPIC_ID_INVALID` |
| `labels` | exactly the three `alz-*` keys from `docs/act-pilot-gcp-terraform-g0.md` (the identity mapping of the product's tag keys); `alz-managed-by` is `alz`; `alz-unit` is a unit id | `LABELS_NOT_IN_CONTRACT` |

Sealing reads the topic under DISCOVERY first. If the topic already exists, sealing refuses with `TOPIC_EXISTS`. If it is absent, sealing writes a typed JSON plan containing the following:

- the request;
- the precondition `ABSENT`;
- the three exact REST calls the request implies:
  - `PUT https://pubsub.googleapis.com/v1/projects/<p>/topics/<t>`, with body `{"labels": …}` and nothing else;
  - `GET` on the same URL, for the read-back;
  - `DELETE` on the same URL, for cleanup;
- `sealNonce`, 16 fresh random bytes (hex) drawn by this seal, so every seal is a new artifact (see "Recovery after a stop");
- `artifactSha256`, computed over the canonical JSON of all of the above;
- the requester's Ed25519 signature over that hash (`signRequest`, the same `REQUEST` statement as every sealed plan). The requester must be on the contract's allowlist (`requester: REQUESTER` in the tests).

Apply verifies the plan before it does anything:

- the plan has exactly its fields;
- the engine and the provider match;
- the environment and project match the contract;
- deriving the calls again from the request gives exactly the sealed calls;
- `sealNonce` is 32 lowercase hex characters;
- the hash, recomputed with the sealed `sealNonce`, matches;
- the signature verifies.

A plan that differs in any of these ways is refused as `PLAN_FORGED`, `ENGINE_NOT_ALLOWED`, `ENVIRONMENT_MISMATCH` or a `REQUESTER_*` code, and no call is made.

## Identities

| Identity | Role on this path | OAuth scope requested |
|---|---|---|
| DISCOVERY | the read before seal, the precondition read at apply, the read-back (observe), and the read before and after cleanup | `https://www.googleapis.com/auth/pubsub` |
| APPLY | the one `PUT` (create) and the one `DELETE` (cleanup) | `https://www.googleapis.com/auth/pubsub` |

**Read-only comes from IAM, not from the OAuth scope.** Pub/Sub accepts exactly two scopes on `projects.topics.get`, `.create` and `.delete`: `cloud-platform` and `pubsub` (the public v1 discovery document). A bearer minted with `cloud-platform.read-only` is refused with 403, so a DISCOVERY bearer with that scope could never read the topic. Both identities therefore request `pubsub`, the narrower of the two accepted scopes, which keeps each bearer to Pub/Sub. What each identity may do is set by its service account's IAM grants (#308): DISCOVERY holds only `pubsub.topics.get`, and APPLY holds `pubsub.topics.create` and `pubsub.topics.delete`. The engine also sends only `GET` with DISCOVERY's bearer and only `PUT` and `DELETE` with APPLY's.

The synthetic fake enforces the same rule: it refuses any Pub/Sub request whose bearer was minted with a scope outside those two, so a regression to a read-only scope fails the tests.

The engine reuses path 5's identities and variables (`gcp-plan.md`, section 2; `docs/act-pilot-gcp-terraform-g0.md`):

- `ALZ_<IDENTITY>_GOOGLE_APPLICATION_CREDENTIALS` is the absolute path of a workload identity federation credential configuration.
- `ALZ_<IDENTITY>_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT` is the identity's service account in the contract's project.

STATE and STATE_WRITE are not used, because there is no state.

**DISCOVERY and APPLY must be separate principals.** Before any token request, the engine runs path 5's identity check (`GCP.ambientRefusal` in `src/apply/providers/gcp.ts`) over the whole environment. Two identities that impersonate the same service account (in any letter case), read the same credential configuration (by path, symlink or hard link), or read the same OIDC token file are refused as `IDENTITY_COLLAPSED`. An identity that carries the operator's own `GOOGLE_*` value is also `IDENTITY_COLLAPSED`, and any other Google, gcloud, metadata or other-cloud variable on an identity is `IDENTITY_NOT_CONFIGURED`. This keeps "DISCOVERY only reads" from resting on IAM alone.

For least privilege, APPLY needs `pubsub.topics.create` and `pubsub.topics.delete`, and DISCOVERY needs `pubsub.topics.get` (for example, `roles/pubsub.viewer`). Path 5's bootstrap grants these roles. This lane does not edit it.

## Tokens: obtained in process, never stored

The engine uses the lighter of the two options: a minimal STS and IAM Credentials exchange, done in process. `gcloud` is not used, so no tool pin is added. The exchange follows the Azure reader's pattern (`src/observe/azure-rest.ts`):

1. Read the identity's credential configuration with path 5's validator, the shared `checkCredentialConfiguration` in `src/tools/gcp-credentials.ts` (re-exported by `src/apply/providers/gcp.ts`), so one file has one verdict on both paths. It is accepted only when all of the following hold:
   - it is a JSON object of at most 64 KiB;
   - its keys are within the allowlist `type`, `audience`, `subject_token_type`, `token_url`, `credential_source` and `universe_domain`;
   - it has no `service_account_impersonation_url` of its own, even one naming the same service account (P1). Impersonation is the identity's `GOOGLE_IMPERSONATE_SERVICE_ACCOUNT` only;
   - `type` is `external_account`;
   - `audience` is a workload identity pool provider;
   - `subject_token_type` is an OIDC token (`jwt` or `id_token`);
   - `token_url`, if present, is `https://sts.googleapis.com/v1/token` (the engine always sends to that URL);
   - `universe_domain`, if present, is `googleapis.com`;
   - `credential_source` is a file source only: `file` (an absolute path), and optionally `format` of type `text`.

   A service-account key file, an authorized-user file, any other key, or a service account outside the contract's project is refused as `IDENTITY_NOT_CONFIGURED` before any request is made.
2. Read the OIDC token file and exchange it at `sts.googleapis.com` for a federated token, in a single POST.
3. Use the federated token in a single POST to `iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/<sa>:generateAccessToken`, with the `pubsub` scope and a lifetime of 300 seconds.

All three tokens are held only in memory, for one call. They are never written, cached, logged, or placed in argv, a child environment, a result or an error. Failures are reported as codes such as `CREDENTIALS`, `HTTP_ERROR` or `UNEXPECTED_RESPONSE`. The tests plant canary tokens and prove that none of them appears in any result.

## Network boundary

Every request passes one gate before it exists:

- a `POST` to exactly `https://sts.googleapis.com/v1/token`;
- a `POST` to an `iamcredentials.googleapis.com` `generateAccessToken` URL;
- a `GET`, `PUT` or `DELETE` to exactly the sealed topic URL on `pubsub.googleapis.com`.

The URL must use https, with no port, userinfo, query or fragment, and must be a URL the parser leaves as written. Anything else is never sent. The production client is `fetch` with `redirect: "error"`, which runs through the runner's approved egress, the same path the Azure reader uses. Tests inject a fake.

## Apply: order, idempotency, kill switch, partial failure

Apply runs these steps in order and fails closed:

1. **Kill switch.** If it is on, the result is `KILL_SWITCH_ACTIVE`. Nothing is sent and nothing is claimed.
2. **Plan verification.** The checks are listed above.
3. **Ledger check.** The ledger directory must be private (see "The ledger"); otherwise the result is `LEDGER_NOT_PRIVATE`. If the plan's `artifactSha256` is already recorded, the result is `ALREADY_APPLIED`.
4. **Precondition read under DISCOVERY.** If the topic now exists, the result is `PLAN_STALE`.
5. **Claim.** The plan is claimed by an exclusive create of `gcp-api-<sha>.json` in the ledger directory, mode 0600. A second apply of the same plan, even a concurrent one, is refused as `ALREADY_APPLIED`.
6. **APPLY token.**
7. **Kill switch again.** If it is now on, the result is `KILL_SWITCH_DURING_APPLY`. Nothing is created, the claim is recorded as `NOT_APPLIED`, and the plan is consumed. The requester seals a new plan (see "Recovery after a stop").
8. **The one `PUT`.** The response decides the outcome:

| Response to the `PUT` | Outcome | Ledger record |
|---|---|---|
| 200 | `APPLIED` | `APPLIED` |
| 409 (created by someone else in the meantime) | `NOT_APPLIED` with code `PLAN_STALE` | `NOT_APPLIED` |
| any other 4xx | `NOT_APPLIED` with code `CREATE_REFUSED` | `NOT_APPLIED` |
| 5xx, or no answer | `UNCERTAIN` with code `CREATE_UNANSWERED` | `UNCERTAIN` |

**Nothing is retried.** An uncertain create is settled by the read-back (`observeGcpApiPlan`), never by sending the create again. Pub/Sub's own `409 ALREADY_EXISTS` makes the create idempotent at the service, and the ledger makes it idempotent here.

There is exactly one mutating call, so partial failure has a single meaning: the topic exists or it does not, and the read-back shows which.

### Recovery after a stop

A sealed plan is applied at most once, whatever its outcome. Recovery is a **new seal**, never a second apply of the same plan. This is the Terraform driver's rule: there, a ledger record means the sealed plan was used, and retrying needs a new preview (a new plan file, so a new artifact) and new approvals.

To make a new seal a new artifact, sealing draws a fresh `sealNonce` and binds it into `artifactSha256`, which the requester signs. Sealing the same request again therefore gives a different artifact, which the ledger has not seen. Without the nonce, the same request would hash to the same artifact, and after any stop the ledger would answer `ALREADY_APPLIED` forever.

What still holds:

- **The same sealed plan is never applied twice.** The ledger is keyed on `artifactSha256`, and a stopped plan stays recorded as `NOT_APPLIED`. Applying it again is `ALREADY_APPLIED`, and cleaning it up is `NOT_RUN_CREATED`.
- **A second topic is never created.** Topic names are unique in a project. Every seal reads the topic first and refuses `TOPIC_EXISTS`; every apply reads it again and refuses `PLAN_STALE`; and Pub/Sub itself answers 409 to a duplicate create, which is recorded as `NOT_APPLIED` with `PLAN_STALE`. Two plans sealed from one request while the topic was absent can therefore create it at most once.

Every stop that records `NOT_APPLIED` is recovered the same way:

| Stop | Recorded | Recovery |
|---|---|---|
| kill switch between the token and the create (`KILL_SWITCH_DURING_APPLY`) | `NOT_APPLIED` | seal again, then apply |
| APPLY token failure (`CREDENTIALS`, `HTTP_ERROR`, `UNEXPECTED_RESPONSE`) | `NOT_APPLIED` | fix the identity, seal again, then apply |
| any 4xx on create, such as a 429 or a 403 (`CREATE_REFUSED`) | `NOT_APPLIED` | seal again, then apply |
| 5xx or no answer (`CREATE_UNANSWERED`) | `UNCERTAIN` | observe first. If the topic exists, sealing again is refused as `TOPIC_EXISTS`, and the uncertain plan's cleanup owns it. If it is absent, seal again |

A kill switch before the claim (`KILL_SWITCH_ACTIVE`) and a stale precondition (`PLAN_STALE` before the claim) record nothing, so the same plan may be applied later.

Ownership is by unit, not by seal. A re-sealed plan carries the same `alz-unit` label as the stopped one. If an `UNCERTAIN` plan and its re-seal both reach cleanup, either can delete the unit's topic, because it carries their identical sealed labels.

### The ledger

The ledger directory holds one record per applied plan. It decides what cleanup may delete, so apply and cleanup refuse it with `LEDGER_NOT_PRIVATE` unless all of these hold:

- it is a real directory, not a symlink;
- it is owned by the user running the engine;
- it has no group or other permission bits (mode `0700` or narrower).

Records are created with mode `0600`. When the authorization lane admits this path, the driver creates and owns the directory, as it does the evidence directory.

Owner gates such as ACT enabled, human invocation, the contract target, approvals, typed phrases and the run records belong to the shared driver. They apply unchanged once the authorization lane admits `GCP_API`. This module duplicates none of them.

## Ownership, verification and cleanup

**Ownership.** A topic belongs to the run only when both of these hold:

- the ledger records this plan as `APPLIED` or `UNCERTAIN`;
- the topic carries exactly the sealed labels, including the run's `alz-unit`.

A label alone never makes a topic deletable.

**Verification (observe).** Under DISCOVERY, `GET` the sealed URL. The run is `verified` only when the topic exists, its `name` is the sealed name, and its labels equal the sealed labels exactly. A missing topic reads as `ABSENT`. A topic with changed labels reads as `PRESENT` but not owned.

**Cleanup.** Cleanup deletes run-created topics only, in this order:

1. If the kill switch is on, stop.
2. Verify the plan.
3. Check the ledger: it must be private (`LEDGER_NOT_PRIVATE`). If it does not record the plan as `APPLIED` or `UNCERTAIN`, the result is `NOT_RUN_CREATED`.
4. Read the topic under DISCOVERY:
   - if it is absent, the result is `ALREADY_ABSENT`, which makes cleanup idempotent;
   - if its labels changed, the topic is kept and the result is `OWNERSHIP_MISMATCH`.
5. Get the APPLY token.
6. Check the kill switch again. If it is on, the result is `KILL_SWITCH_DURING_CLEANUP`.
7. Send one `DELETE`.
8. Read the topic back under DISCOVERY. It must be absent; otherwise the result is `CLEANUP_NOT_VERIFIED`.
9. Record `CLEANED` in the ledger.

Cleanup never lists, searches or deletes anything by label or prefix.

**Known gap: no etag on delete.** The label check (step 4) and the `DELETE` (step 7) are separate calls, and Pub/Sub's `topics.delete` takes no etag or other precondition. A label change between them is not caught. This is accepted for one run-named `alz-` topic in DEV: the window spans only the APPLY token exchange, and the topic id itself is the run's. A kind whose delete takes an etag binds it instead.

## Why no Terraform

Path 5 already covers Terraform on GCP. A second Terraform path, whether Infrastructure Manager or the `google` provider driven differently, would duplicate it without testing anything new.

This path proves the opposite shape: a plan that *is* the exact calls, with no state file, no backend, no provider plugin and no binary to pin. The cost is breadth. Each new kind needs its own allowlisted fields, URLs and read-back, so the engine stays one kind until the owner asks for more.

## Evidence

| Evidence | Mode | Where |
|---|---|---|
| seal, apply, a second apply refused, stale plan (exists at seal, at apply, created during the call; changed after), kill switch before and during, uncertain create without retry, observe, idempotent cleanup | SYNTHETIC | `test/apply-gcp-api.test.ts`, with a fake for STS, IAM Credentials and Pub/Sub |
| recovery after a stop by a new seal (kill switch during apply, APPLY token failure, 429 and 403 on create), with the stopped plan still `ALREADY_APPLIED`; two seals of one request create one topic | SYNTHETIC | same file |
| both identities request the `pubsub` scope; the fake refuses a bearer whose scope Pub/Sub does not accept, `cloud-platform.read-only` included | SYNTHETIC | same file |
| forged plan, disallowed kind or field, wrong project, foreign labels, a key file or foreign service account, an impersonation URL or unknown key in the credential configuration, collapsed identities (same service account, configuration, symlink or token file), a ledger that is not private, a lookalike host | SYNTHETIC | same file |
| live STS exchange, impersonation, which principal Google sees, real Pub/Sub responses | **not run** | G2, owner-run and owner-authorized |

**The Pub/Sub emulator is not used.** It has no IAM and no token exchange, so it would prove only the REST shape the fake already scripts, and the engine's fixed `https://pubsub.googleapis.com` gate would need an override that production must not have.

## What the authorization lane must add (not in this lane)

The authorization lane owns `src/apply/contract.ts`. This lane needs it to add:

- `GCP` to `ProviderId` and `PROVIDER_IDS`;
- `GCP_API` to `EngineId` and `ENGINE_IDS`, valid only with `GCP`;
- the DEV-only scope for this path;
- a contract target shape of `projectId` only, with no backend or workspace, because the engine keeps no state;
- the driver's call into `sealGcpApiPlan`, `applyGcpApiPlan`, `observeGcpApiPlan` and `cleanupGcpApiPlan`.

Until then, admission refuses `GCP_API`. The release gate `act:gcp-api` is added to `config/release/scope.json` and `status.json` once `ACT_RELEASE_PATHS` can name `{ provider: "GCP", engine: "GCP_API" }`, which also depends on those types.
