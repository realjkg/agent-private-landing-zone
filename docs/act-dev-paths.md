# ACT DEV release: six-path baseline

Status: written 2026-10-27 against `origin/main` at `0b0aa2b` (merge of #296) and the open PRs #287, #289, #293, #297 and #298, for the owner decision "rebaseline of the narrow ACT-DEV release" (issue #39, comment 6443352284). It is the input to the canonical work graph (`config/release/work-graph.json`, owned by the governance lane). This page enables nothing: ACT stays DISABLED, the repository ships no pilot contract (#313 retires the old `config/act-pilot-contract.sha256` pin; the contract's `authorize` entry is the switch), and no agent writes the contract, holds an approver key or initiates an apply.

Every status on this page is read from code, tests and config, not from chat. **No live evidence exists for any path.** SYNTHETIC means a fake engine or fake cloud CLI; EMULATED means a real engine against a local emulator. Neither is live provider qualification (`AGENTS.md`).

## Status lines

| # | Path | Status | Concrete blockers |
|---|---|---|---|
| 1 | AWS Terraform | **EXECUTABLE** (synthetic end to end; emulated G1b passed before backend pinning) | #297 backend pinning, then G1b re-run on it (A1); #293 DISCOVERY scope; authorization switch (contract-based authorization or the pin fallback); OWNER G0 roles, bootstrap, G2 |
| 2 | AWS CDK / CloudFormation | **PARTIAL** (synthetic end to end with a fake `aws`; every AWS fact in `engines/cdk.ts` UNVERIFIED) | No DEV-only contract exception (CDK needs DEV, QA and PROD accounts today); no emulated or real-CLI check of the CDK assumptions; `act:aws-cdk` NOT_RUN; OWNER bootstrap (`engine = "CDK"`) and G2 |
| 3 | Azure Terraform | **EXECUTABLE** (synthetic end to end; emulated G1b passed with SAS and access keys, which Entra-only will refuse) | #298 DEV-only exception; #297 (the `azurerm` backend block is not judged on `main`); #287/#289 Entra-only state; G1b re-run on that path (harness drafted, no PR); `bootstrap/azure` needs three subscriptions; Z1 G0 package; Z4 DISCOVERY review; OWNER G2 |
| 4 | Azure Bicep / ARM | **ADMITTED IN CODE, DEV ONLY** (owner decision E2): the `BICEP` engine is registered; seal (what-if as APPLY), apply (one deployment stack), observe and whole-stack cleanup pass SYNTHETIC through the driver | No console journey test yet; no ARM emulator, so no emulated run; live G2 needs the owner's authorization; `act:azure-bicep` is BLOCKED |
| 5 | GCP Terraform | **NOT STARTED** (code); PLAN approved, G0 package and G-7 emulator spike written | No `GCP` provider id or spec, no bootstrap, no reader, no classifier branch, no gates; slices S1 to S7 unbuilt; DEV-only contract exception not yet in `contract.ts` |
| 6 | GCP API-native provisioning | **NOT STARTED** (no design) | No engine chosen (Infrastructure Manager is only a named candidate); depends on path 5's GCP provider spec, reader and bootstrap; no gates |

## Shared components and where paths fork

The apply path already separates generic modules from per-provider and per-engine specs (`src/apply/provider.ts`, `src/apply/engine-spec.ts`). A new path adds a spec; it does not fork the generic modules.

| Component | Module(s) | Shared by | Fork point |
|---|---|---|---|
| Contract (authorization today) | `src/apply/contract.ts`, `contract-check.ts` | all | `validate` DEV-only rule: AWS+TERRAFORM on `main`, +AZURE in #298. Contract-based authorization (#313) replaces the pin with the contract's default-deny `authorize` entry and folds #298 into one DEV-only rule for every implemented path |
| Requester signing, approvals, quorum | `src/apply/approval.ts`, `seal.ts`, `nonces.ts` | all | none |
| Seal, driver, ledger, kill switch | `src/apply/seal.ts`, `driver.ts`, `ledger.ts`, `run-records.ts` | all | engine spec `plan` / `openApply` / `openCleanup` |
| Readiness and preflight | `src/apply/readiness.ts`, `identities.ts` | all | spec `identities`, `identityTargetVariables`, `ambientRefusal` |
| Evidence, live record, recovery record, report | `src/apply/evidence.ts`, `live-record.ts`, `recovery-record.ts`, `lifecycle-report.ts` | all | `mutation` / `cleanupMutation` strings per engine |
| Console bridge and wizard | `src/cli/ui-channel.ts`, `src/operator-ui/app/pilot/*` | all | `accountNoun`/`targetNoun`; a few AWS/AZURE strings (7 in `ui-channel.ts`, 6 in `pilot-copy.ts`) |
| Release admission | `src/qualification/release-admission.ts`, `preview-gate.ts` | all | `ACT_RELEASE_PATHS` (3 rows), `PROVIDERS` (AWS, AZURE) |
| **Identity** (provider-specific) | `src/apply/providers/{aws,azure}.ts`, `src/tools/identity.ts`, `src/tools/profiles.ts` | per provider | GCP has none |
| **Planning and execution** (engine-specific) | `src/apply/engines/{terraform,cdk}.ts` | per engine | Bicep and GCP-native have none |
| **Ownership** (unit tags) | `src/apply/unit.ts`, `src/teardown/unit.ts`, spec `tagAttributes` | per provider | GCP labels designed, not built |
| **Verification** (independent read) | `src/observe/aws-cli.ts` (Cloud Control), `src/observe/azure-rest.ts` (ARM), `src/apply/observe.ts` `openReader` | per provider | `openReader` refuses any third provider (`CLEANUP_NOT_SUPPORTED`) |
| **Cleanup** (classifier, removal) | `src/apply/cleanup-proposal.ts` `protectionOf`, `src/observe/aws-leaf-types.ts`, `aws-containers.ts`, `leftovers.ts` | per provider and engine | Terraform: targeted destroy; CDK: removal change set; no GCP branch |

## Path 1: AWS Terraform

| Field | Baseline |
|---|---|
| Minimal workload | One tagged `aws_cloudwatch_log_group` in `us-east-2`, 30-day retention (the ACT-DEV-1 canary, `docs/act-dev-1.md`; fixtures `test/fixtures/live/terraform/aws-log-group.*`). Cloud Control type `AWS::Logs::LogGroup` (`src/observe/verify.ts`), leaf-allowlisted for cleanup (`src/observe/aws-leaf-types.ts`) |
| Seal / apply / observe / cleanup | Present: `engines/terraform.ts` (`plan`, `openApply`, `openCleanup`, `stateDocument`), `providers/aws.ts`, `observe.ts` AWS branch |
| Missing execution code | (1) Backend pinning: `src/apply/backend-pin.ts` replaces `backend-block.ts`, whose S3 rule still passes the reviewer's redirection reproduction (#297). (2) Remove: run-created policy removal (`src/observe/run-created-policies.ts`, removal lane PR A) and generated-artifact removal (`src/apply/workspace-removal.ts`, `remove-workspace`, PR B); neither has a PR. (3) Authorization: `src/apply/act-policy.ts` and the seal/driver/evidence bindings (contract-based authorization lane, no PR) |
| DEV prerequisites | `bootstrap/aws` with `engine = "TERRAFORM"` (OIDC provider, four web-identity roles, versioned S3 bucket with `use_lockfile`, budget); #293 changes DISCOVERY scope, so bootstrap after it merges. Pins: Terraform 1.16.4 (`config/tool-pins.json`); AWS CLI 2.38.6 is pinned but not used by this path. DEV-only exception: on `main` (ACT-DEV-1) |
| Authorization | Contract names `provider: AWS`, `engine: TERRAFORM`, `targets.DEV.{accountId, region, backend, workspace}`, `enabledEnvironments: ["DEV"]`, operations apply, cleanup, remove. Identities DISCOVERY, STATE, STATE_WRITE, APPLY, all distinct; qualification attests STATE_WRITE and APPLY from CloudTrail. Requester signs the sealed request; `requiredApprovals.DEV` at least 1; cleanup has its own approval |
| Failing tests | No path-specific failure in `npm run test:quiet`; one timing-dependent console test ("Test run"). Opt-in: `test/apply-emulated-aws.test.ts` (real Terraform + moto) passed 2026-10-27 (#279), before #297; re-run owed (A1). Matrix row `AWS TERRAFORM`: prepare, preview, approve, execute, observe, cleanup and the four proofs SYNTHETIC_PASS; live BLOCKED |
| Authentic acceptance evidence | `act:aws-terraform` (LIVE_ACT, `./alz apply record-live`), `aws-provider` (LIVE_PROVIDER), `act-run-recovery` (ACT_RECOVERY, first live path). All exist in `status.json`; none has evidence. `preview:terraform-aws-brownfield` (LIVE_PREVIEW) was dropped by the owner on 2026-10-28 (#39, 6480066863): OUT_OF_SCOPE, because E1 makes APPLY seals create-only |

## Path 2: AWS CDK / CloudFormation

| Field | Baseline |
|---|---|
| Minimal workload | A pre-synthesized `cdk.out` with one stack, no assets, holding one `AWS::Logs::LogGroup` (the path 1 canary, so the bootstrap APPLY policy and the cleanup allowlist are the same). The tests use an `AWS::SNS::Topic` (`test/apply-cdk.test.ts`); either is leaf-allowlisted |
| Seal / apply / observe / cleanup | Present in `engines/cdk.ts`: seal creates the change set (not executed), apply executes exactly it, `stateDocument` reads `describe-stack-resources`, cleanup is a removal change set that never deletes the stack, `qualify` runs describe-stacks per identity |
| Missing execution code | (1) DEV-only scope: `src/apply/contract.ts` `validate` refuses `enabledEnvironments` for CDK (#298 keeps that). (2) Every AWS/CloudFormation fact in `engines/cdk.ts` is marked UNVERIFIED (from memory; only a fake `aws` ran). No emulated harness exists. (3) Remove (PR B) must cover `cdk.out` copies and change-set files; run-created IAM stays PROTECTED_IDENTITY. (4) Authorization entries must name CDK separately from Terraform (owner decision 6443124357) |
| DEV prerequisites | `bootstrap/aws` with `engine = "CDK"` (three roles: DISCOVERY, CHANGESET, APPLY; no bucket; `cdk_stack_name`). AWS CLI 2.38.6 pin (#288); `prepare --aws-cli-version` until qualified. Without a DEV-only exception, three AWS accounts (DEV, QA, PROD) and two PROD approvers |
| Authorization | Contract names `provider: AWS`, `engine: CDK`, `targets.<ENV>.{accountId, region, backend = stack name}`. Identity separation: CHANGESET creates, APPLY executes, DISCOVERY reads; qualification attests CHANGESET and APPLY. Change-set capabilities limited to `CAPABILITY_IAM`/`NAMED_IAM`; transforms, macros, custom resources and nested stacks refused at seal |
| Failing tests | No path-specific failure in `npm run test:quiet`. No opt-in emulated test. Matrix row `AWS CDK`: all six steps and four proofs SYNTHETIC_PASS; live BLOCKED (after AWS Terraform) |
| Authentic acceptance evidence | `act:aws-cdk` (LIVE_ACT, status NOT_RUN, owner ENGINEERING), `aws-provider`. `preview:cdk-aws-brownfield` (LIVE_PREVIEW) was dropped by the owner on 2026-10-28 (#39, 6480066863): OUT_OF_SCOPE, because E1 makes APPLY seals create-only. `preview:cloudformation-aws-existing` is OUT_OF_SCOPE in `scope.json` too |

## Path 3: Azure Terraform

| Field | Baseline |
|---|---|
| Minimal workload | **PROPOSAL:** one empty, tagged `azurerm_virtual_network` (no charge) in the bootstrap's apply resource group (`bootstrap/azure/modules/environment/main.tf`, `azurerm_resource_group.apply`). The cleanup tests use `azurerm_log_analytics_workspace`, which has a soft-delete period; the resource group itself is kept as CONTAINS_OTHERS, so it cannot be the workload |
| Seal / apply / observe / cleanup | Present: `engines/terraform.ts`, `providers/azure.ts`, `observe/azure-rest.ts` (in-process DISCOVERY token exchange), Azure branch of `cleanup-proposal.ts` |
| Missing execution code | (1) `azurerm` backend pinning (#297; on `main` the Azure backend block is not judged at all). (2) Entra-only state auth (#287, #289; must rebase onto #297 and drop their own reader). (3) Remove: Azure policy definitions and assignments are PROTECTED today (`AZURE_IDENTITY_TYPE` matches `azurerm_policy_*` and `*_policy_assignment`); the removal lane PR A adds the run-created allowlist and confirms Azure cleanup. (4) Authorization entries (contract lane) |
| DEV prerequisites | `bootstrap/azure` requires exactly three distinct subscriptions (`variables.tf`; DEV, QA, PROD hard-coded in `providers.tf`, `environments.tf`, `identities.tf`): Z3 adds a DEV-only mode. Four federated app registrations; state accounts with keys and SAS disabled. Pins: Terraform 1.16.4 only; no `az` pin (the path runs no `az`). DEV-only exception: #298 |
| Authorization | Contract names `provider: AZURE`, `engine: TERRAFORM`, `targets.DEV.{tenantId, subscriptionId, backend "<account>/<container>/<key>", workspace}`, `enabledEnvironments: ["DEV"]`. Same four identities; one client per identity across subscriptions (`principalPerEnvironment: false`), attested from sign-in and storage logs. Z4: DISCOVERY Reader not yet reviewed against "control-plane metadata only" |
| Failing tests | No path-specific failure in `npm run test:quiet`. Opt-in: `test/apply-emulated.test.ts` (real Terraform + Azurite) passed 2026-10-27 with SAS and access keys; Entra-only will refuse those, so the G1b harness (drafted, no PR) adds a test-only SAS allowance. Matrix row `AZURE TERRAFORM`: all steps and proofs SYNTHETIC_PASS; live BLOCKED |
| Authentic acceptance evidence | `act:azure-terraform` (LIVE_ACT), `azure-provider` (LIVE_PROVIDER). All exist; none has evidence. `preview:terraform-azure-brownfield` (LIVE_PREVIEW; producer `./alz apply preview-evidence` exists, unchanged) was dropped by the owner on 2026-10-28 (#39, 6480066863): OUT_OF_SCOPE, because E1 makes APPLY seals create-only |

## Path 4: Azure Bicep / ARM

| Field | Baseline |
|---|---|
| Minimal workload | **PROPOSAL:** the same empty, tagged virtual network as path 3, compiled to one ARM JSON template (`bicep build` output, supplied pre-built like `cdk.out`), deployed as one resource-group **deployment stack** in the apply resource group. The teardown unit already models Bicep state as `{ scope, deploymentStackName }` (`src/teardown/types.ts`, `unit.ts`) |
| What exists | The `BICEP` engine (`src/apply/engines/bicep.ts`), registered in `src/apply/engine-spec.ts` and admitted for DEV only (owner decision E2; `docs/act-pilot-bicep.md`): seal compiles `main.bicep` with the pinned bicep and runs the ARM deployment what-if as APPLY; apply creates one deployment stack with `denyWriteAndDelete` as APPLY; the blueprint is the stack's managed resources; observe reads ARM independently as DISCOVERY; cleanup deletes the whole stack with `deleteResources`, never the group. `prepare.ts` treats Bicep as Azure's secondary path. Pins: az 2.91.0, bicep 0.47.16 (`config/tool-pins.json`). Committed canary: `qualification/azure/act-dev1-bicep-canary` |
| Missing execution code | None for DEV. Not built: a console journey test through the real pilot router (so the matrix steps cannot be SYNTHETIC_PASS), and QA or PROD (refused by design) |
| DEV prerequisites | `bootstrap/azure` with `bicep_deployment_stacks = true` (DEV only): a custom role at the pilot resource group, assigned to APPLY only, whose one new effective action beside Contributor is `manageDenySetting`; DISCOVERY keeps Reader |
| Authorization | Contract names `provider: AZURE`, `engine: BICEP`, `enabledEnvironments: ["DEV"]`, `tenantId`, `subscriptionId`, `resourceGroup`, `location`, the stack name (`backend`) and the `canary` allowlist (`config/act-pilot-contract.azure-bicep-dev.example.json`). Tenant, subscription, group, location and canary join the target hash. Deny settings and `actionOnUnmanage` are fixed by the engine, never by the template |
| Failing tests | None. SYNTHETIC: `test/apply-bicep.test.ts`, `test/apply-bicep-admission.test.ts`, `test/act-dev1-bicep-canary.test.ts`. Matrix row `AZURE BICEP`: steps BLOCKED on a console journey test, proofs SYNTHETIC_PASS, live BLOCKED on G2 |
| Authentic acceptance evidence | `act:azure-bicep` (LIVE_ACT, in `ACT_RELEASE_PATHS` and `scope.json`, BLOCKED), `azure-provider` (shared). None has evidence. `preview:bicep-azure-brownfield` (LIVE_PREVIEW) was dropped by the owner on 2026-10-28 (#39, 6480066863): OUT_OF_SCOPE, because E1 makes APPLY seals create-only |

## Path 5: GCP Terraform

| Field | Baseline |
|---|---|
| Minimal workload | **PROPOSAL:** one labeled `google_pubsub_topic` (no charge while idle, deletes at once, listed by Cloud Asset Inventory). A logging bucket is not suitable: deletion is delayed |
| What exists | PLAN approved (6433121154); `docs/act-pilot-gcp-terraform-g0.md` (G0, S0); `docs/act-pilot-simulation-gcp.md` (G-7 spike: the `gcs` backend honors `STORAGE_EMULATOR_HOST` against fake-gcs-server; EMULATED, outside the repository). Read-only `src/providers/gcp/asset-inventory.ts` and the offline showcase |
| Missing execution code | Slices S1 to S7 of the PLAN: `ProviderId` `GCP` (`types.ts`), `src/apply/providers/gcp.ts`, `provider.ts` registration, `src/tools/identity.ts` (`PRINCIPAL_NAME`), `src/tools/profiles.ts` (GOOGLE variables, `*.googleapis.com`), `engines/terraform.ts` (`providers`, STATE_WRITE settings), a `gcs` rule in #297's `backend-pin.ts`, `src/observe/gcp-rest.ts` and the `openReader` branch, `verify.ts` `VerifierId`, `run-records.ts`, the GCP branch of `protectionOf`, console parity |
| DEV prerequisites | `bootstrap/gcp` (none exists): WIF pool and provider, four service accounts, versioned state bucket, budget, `iam.disableServiceAccountKeyCreation`. Pins: Terraform 1.16.4; `gcloud` only if the read-only evidence runner uses it. DEV-only exception: O1 is answered (6443352284: GCP Terraform DEV is in the DEV pilot scope, full gates), but `contract.ts` still refuses it; P1, P2 and P4 are adopted as fail-closed defaults. Owner items for the bootstrap: P3 (lock-version retention) and P5 (Data Access audit logs, may incur cost) |
| Authorization | Contract names `provider: GCP`, `engine: TERRAFORM`, `projectId`, `region`, `backend "<bucket>/<prefix>"`, environment, operations. Identities: four WIF principals, each impersonating its own service account (the SA email is the attested principal); no key files; `google-beta` refused |
| Failing tests | None. SYNTHETIC: `test/apply-gcp-admission.test.ts` (#339 admits GCP Terraform for DEV only). Matrix row `GCP TERRAFORM`: steps BLOCKED on a console journey test, live BLOCKED on the owner's DEV run |
| Authentic acceptance evidence | `act:gcp-terraform` (LIVE_ACT, in `ACT_RELEASE_PATHS` and `scope.json`, BLOCKED) and `gcp-provider` (LIVE_PROVIDER, BLOCKED). None has evidence. `preview:terraform-gcp-brownfield` was dropped by the owner on 2026-10-28 (#39, 6480066863): OUT_OF_SCOPE, because E1 makes APPLY seals create-only. The GCP brownfield preview is dropped; GCP Terraform ACT and GCP API-native ACT are in scope for this DEV release (#39, 6481421924) |

## Path 6: GCP API-native provisioning

| Field | Baseline |
|---|---|
| Minimal workload | **PROPOSAL:** the same labeled Pub/Sub topic as path 5, created by one typed API request (`topics.create`) and removed by `topics.delete` |
| What exists | Nothing for apply. `journeys.json` row `GCP GCP_API` (named `NATIVE_API` before decision D18, `docs/act-pilot-gcp-api-driver.md`); the GCP PLAN names Infrastructure Manager as the candidate, not decided |
| Missing execution code | An engine decision first (OWNER): Infrastructure Manager (managed Terraform; adds a Cloud Build service account the pilot cannot bind as APPLY, and a server-side plan the seal cannot hash byte for byte) or a typed request engine (proposal: a closed table of create/delete request bodies, sealed verbatim, executed in process as APPLY). Then: `EngineId`, `src/apply/engines/gcp-native.ts`, ownership by labels, a `stateDocument` from the API responses; reuses path 5's provider spec, reader and classifier |
| DEV prerequisites | Path 5's `bootstrap/gcp` minus the state bucket (no state backend); identities DISCOVERY and APPLY (plus a preview identity if Infrastructure Manager is chosen). DEV-only exception: owner decision |
| Authorization | Contract names `provider: GCP`, `engine: <native id>`, `projectId`, `region`, environment, operations; the closed operation table is part of the reviewed contract or engine spec. SA impersonation as path 5 |
| Failing tests | None (no tests). Matrix row `GCP GCP_API`: all NOT_IMPLEMENTED |
| Authentic acceptance evidence | **Missing gates:** `act:gcp-<native>`, a native preview gate, and `gcp-provider` (shared with path 5) |

## Ordered work per path

Sizes: S (under a day), M (one to three days), L (more than three days). OWNER items need a person, live credentials or spend. Cross-path dependencies are named.

| Path | # | Item | Who | Size | Depends on |
|---|---|---|---|---|---|
| shared | X1 | Contract-based authorization (default-deny entries by provider, engine, account, environment, operation; digest bound at seal, approval, admission, execution; tested migration from the pin; #313) | ENGINEERING | L | before any path's enablement commit; pin fallback (pin-prep lane) if it would delay path 1 |
| shared | X2 | Removal lane PR A (run-created policy allowlist incl. Azure) and PR B (generated-artifact removal) | ENGINEERING | M + M | X1's authorized call site for PR B |
| shared | X3 | Release wiring for new paths: `ACT_RELEASE_PATHS`, `scope.json` `actPaths`, `status.json` rows, `preview-gate.ts` `PROVIDERS` | ENGINEERING | S per path | the path's engine or provider spec |
| 1 | A0 | Merge #297 (backend pinning) and #293 (DISCOVERY scope) | ENGINEERING | S (review) | none |
| 1 | A1 | Re-run `test/apply-emulated-aws.test.ts` on the pinned path; record it | ENGINEERING | S | A0 |
| 1 | A2 | Correct `act:aws-terraform` `nextAction` and the G0 page (G1b is done) | ENGINEERING | S | `status.json` owner |
| 1 | A3 | G0 roles, DEV account, issuer, bootstrap, keys, contract, preflight | OWNER | M | A0 (#293) |
| 1 | A4 | Enablement commit, `qualify`, one supervised apply, `record-live`, cleanup, admission | OWNER | M | A1, A3, X1 |
| 2 | C1 | DEV-only exception for AWS CDK (owner decision, then `contract.ts` and tests) | OWNER + ENGINEERING | S | X1 (the entry shape) |
| 2 | C2 | Verify the UNVERIFIED CDK/CloudFormation facts: an emulated or recorded-output harness, then the doc list in `docs/act-pilot-apply.md` ("CDK") | ENGINEERING | M | none |
| 2 | C3 | Bootstrap `engine = "CDK"`, contract, qualify, supervised apply and cleanup | OWNER | M | C1, C2, path 1 live first (journey row) |
| 3 | Z0 | Merge #298, then #287/#289 rebased on #297 | ENGINEERING | S (review) | A0 (#297) |
| 3 | Z2 | Azure G1b on the Entra-only, pinned path (test-only SAS allowance) | ENGINEERING | M | Z0 |
| 3 | Z1 | Azure G0 page and DEV-only example contract | ENGINEERING | S | #298 |
| 3 | Z3 | DEV-only mode for `bootstrap/azure` | ENGINEERING | M | none (workaround: three subscriptions) |
| 3 | Z4 | DISCOVERY scope review (Reader) | ENGINEERING | S | none |
| 3 | Z5 | Bootstrap, contract, qualify, supervised apply and cleanup | OWNER | M | Z0 to Z4, X1 |
| 4 | B0 | Owner choices: deny settings, DEV-only exception for Bicep | OWNER | S | none |
| 4 | B1 | `BICEP` engine spec: seal (what-if, template bytes), apply (deployment stack), state document, removal-by-update cleanup | ENGINEERING | L | X1 |
| 4 | B2 | `az` and `bicep` pins; bootstrap identities for the engine | ENGINEERING | M | B0 |
| 4 | B3 | Classifier and address rules for ARM ids and stacks; console parity; matrix row to SYNTHETIC_PASS; X3 | ENGINEERING | M | B1 |
| 4 | B4 | Emulated or recorded-output check of the deployment-stack behavior (no Azure emulator exists for ARM: likely recorded output only) | ENGINEERING | M | B1 |
| 4 | B5 | Supervised DEV apply and cleanup | OWNER | M | B1 to B4 |
| 5 | G0 | Decide P3 and P5 (bootstrap only; they do not block G1) | OWNER | S | none |
| 5 | G0b | DEV-only exception for GCP Terraform in `contract.ts` (O1 answered) | ENGINEERING | S | X1, G1 |
| 5 | G1 | S1 provider spec and identities | ENGINEERING | L | #297 (backend-pin `gcs` rule), X1 |
| 5 | G2 | S2 `bootstrap/gcp` (offline-validated) | ENGINEERING | M | G0 |
| 5 | G3 | S3 reader, S4 classifier, S5 gates (X3), S6 emulated G1b, S7 console | ENGINEERING | L | G1 |
| 5 | G4 | Bootstrap, contract, qualify, supervised apply and cleanup | OWNER | M | G1 to G3 |
| 6 | N0 | Choose the native engine | OWNER | S | none |
| 6 | N1 | Native engine spec, ownership, state document, cleanup | ENGINEERING | L | N0, G1, G3 (reader, classifier) |
| 6 | N2 | Gates (X3), tests, console parity | ENGINEERING | M | N1 |
| 6 | N3 | Supervised DEV apply and cleanup | OWNER | M | N1, N2, G2 |

## Test run

`npm run test:quiet` on `origin/main` at `0b0aa2b`, port 11435 free before the run (one run, 13 min 42 s):

| Stage | Result |
|---|---|
| `test:node` | 3258 passed, 0 failed, 3 skipped |
| `test:ui` | 1 failed of 13 files: `test/pilot-wizard.test.tsx` > "an open dialog keeps focus: a step change or a re-sent unlock while it is open never moves focus to the step heading..." (line 388: the **Back** button was not found after the dialog closed) |

The failing file passed 56 of 56 twice when run alone (`npx vitest run test/pilot-wizard.test.tsx`), so it is timing-dependent under full-suite load, not a deterministic regression. It is in the shared pilot wizard, so it touches every path's console journey. It is recorded here as an open flaky test for its owning lane (the console), not waived. Opt-in tests are skipped by default: `test/apply-emulated.test.ts` (needs `ALZ_SIM_TERRAFORM`, `ALZ_SIM_AZURITE`) and `test/apply-emulated-aws.test.ts` (needs `ALZ_SIM_TERRAFORM`, `ALZ_SIM_MOTO`). No opt-in test exists for paths 2, 4, 5 or 6.
