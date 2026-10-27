# ACT pilot path 6: GCP API-native provisioning (`GCP_API`)

Status: engineering only. **ACT = DISABLED**, the pin stays empty, and nothing in this path has run against Google Cloud. All evidence is **SYNTHETIC**. The engine is not admitted: `src/apply/contract.ts` has no `GCP_API` engine or `GCP` provider, so admission refuses any contract that names it, and nothing in the product can reach the engine. The authorization lane admits it later, under the same gates as every path.

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
- `artifactSha256`, computed over the canonical JSON of all of the above;
- the requester's Ed25519 signature over that hash (`signRequest`, the same `REQUEST` statement as every sealed plan). The requester must be on the contract's allowlist (`requester: REQUESTER` in the tests).

Apply verifies the plan before it does anything:

- the plan has exactly its fields;
- the engine and the provider match;
- the environment and project match the contract;
- deriving the calls again from the request gives exactly the sealed calls;
- the hash matches;
- the signature verifies.

A plan that differs in any of these ways is refused as `PLAN_FORGED`, `ENGINE_NOT_ALLOWED`, `ENVIRONMENT_MISMATCH` or a `REQUESTER_*` code, and no call is made.

## Identities

| Identity | Role on this path | OAuth scope requested |
|---|---|---|
| DISCOVERY | the read before seal, the precondition read at apply, the read-back (observe), and the read before and after cleanup | `cloud-platform.read-only` |
| APPLY | the one `PUT` (create) and the one `DELETE` (cleanup) | `pubsub` |

The engine reuses path 5's identities and variables (`gcp-plan.md`, section 2; `docs/act-pilot-gcp-terraform-g0.md`):

- `ALZ_<IDENTITY>_GOOGLE_APPLICATION_CREDENTIALS` is the absolute path of a workload identity federation credential configuration.
- `ALZ_<IDENTITY>_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT` is the identity's service account in the contract's project.

STATE and STATE_WRITE are not used, because there is no state.

For least privilege, APPLY needs `pubsub.topics.create` and `pubsub.topics.delete`, and DISCOVERY needs `pubsub.topics.get` (for example, `roles/pubsub.viewer`). Path 5's bootstrap grants these roles. This lane does not edit it.

## Tokens: obtained in process, never stored

The engine uses the lighter of the two options: a minimal STS and IAM Credentials exchange, done in process. `gcloud` is not used, so no tool pin is added. The exchange follows the Azure reader's pattern (`src/observe/azure-rest.ts`):

1. Read the identity's credential configuration, at most 64 KiB. It is accepted only when all of the following hold:
   - `type` is `external_account`;
   - `audience` is a workload identity pool provider;
   - `token_url` is `https://sts.googleapis.com/v1/token`;
   - `credential_source` is exactly `{ "file": <absolute path> }`;
   - it contains no `private_key`, `private_key_id`, `client_secret`, `refresh_token`, `token` or `access_token`;
   - any `service_account_impersonation_url` names the same service account.

   A service-account key file, or a service account in another project, is refused as `IDENTITY_NOT_CONFIGURED` before any request is made.
2. Read the OIDC token file and exchange it at `sts.googleapis.com` for a federated token, in a single POST.
3. Use the federated token in a single POST to `iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/<sa>:generateAccessToken`, with the identity's scope and a lifetime of 300 seconds.

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
3. **Ledger check.** If the plan's `artifactSha256` is already recorded, the result is `ALREADY_APPLIED`.
4. **Precondition read under DISCOVERY.** If the topic now exists, the result is `PLAN_STALE`.
5. **Claim.** The plan is claimed by an exclusive create of `gcp-api-<sha>.json` in the ledger directory, mode 0600. A second apply of the same plan, even a concurrent one, is refused as `ALREADY_APPLIED`.
6. **APPLY token.**
7. **Kill switch again.** If it is now on, the result is `KILL_SWITCH_DURING_APPLY`. Nothing is created, the claim is recorded as `NOT_APPLIED`, and the plan is consumed. The requester seals a new plan.
8. **The one `PUT`.** The response decides the outcome:

| Response to the `PUT` | Outcome | Ledger record |
|---|---|---|
| 200 | `APPLIED` | `APPLIED` |
| 409 (created by someone else in the meantime) | `NOT_APPLIED` with code `PLAN_STALE` | `NOT_APPLIED` |
| any other 4xx | `NOT_APPLIED` with code `CREATE_REFUSED` | `NOT_APPLIED` |
| 5xx, or no answer | `UNCERTAIN` with code `CREATE_UNANSWERED` | `UNCERTAIN` |

**Nothing is retried.** An uncertain create is settled by the read-back (`observeGcpApiPlan`), never by sending the create again. Pub/Sub's own `409 ALREADY_EXISTS` makes the create idempotent at the service, and the ledger makes it idempotent here.

There is exactly one mutating call, so partial failure has a single meaning: the topic exists or it does not, and the read-back shows which.

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
3. Check the ledger state. If the plan was never applied, the result is `NOT_RUN_CREATED`.
4. Read the topic under DISCOVERY:
   - if it is absent, the result is `ALREADY_ABSENT`, which makes cleanup idempotent;
   - if its labels changed, the topic is kept and the result is `OWNERSHIP_MISMATCH`.
5. Get the APPLY token.
6. Check the kill switch again. If it is on, the result is `KILL_SWITCH_DURING_CLEANUP`.
7. Send one `DELETE`.
8. Read the topic back under DISCOVERY. It must be absent; otherwise the result is `CLEANUP_NOT_VERIFIED`.
9. Record `CLEANED` in the ledger.

Cleanup never lists, searches or deletes anything by label or prefix.

## Why no Terraform

Path 5 already covers Terraform on GCP. A second Terraform path, whether Infrastructure Manager or the `google` provider driven differently, would duplicate it without testing anything new.

This path proves the opposite shape: a plan that *is* the exact calls, with no state file, no backend, no provider plugin and no binary to pin. The cost is breadth. Each new kind needs its own allowlisted fields, URLs and read-back, so the engine stays one kind until the owner asks for more.

## Evidence

| Evidence | Mode | Where |
|---|---|---|
| seal, apply, a second apply refused, stale plan (exists at seal, at apply, created during the call; changed after), kill switch before and during, uncertain create without retry, observe, idempotent cleanup | SYNTHETIC | `test/apply-gcp-api.test.ts`, with a fake for STS, IAM Credentials and Pub/Sub |
| forged plan, disallowed kind or field, wrong project, foreign labels, a key file or foreign service account, a lookalike host | SYNTHETIC | same file |
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
