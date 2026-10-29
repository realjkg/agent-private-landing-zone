# PLAN-2: ACT for the full landing zone, with an agent channel after a human signature

Status: **PROPOSED. OWNER APPROVAL REQUIRED: policy change.** Written by lane PLAN-2 (docs only) under the owner decision record of 2026-10-29 (issue #39, comment 6511236052, "widen ACT beyond the canary pilot"). Nothing here is in force until the owner merges this PLAN and the `AGENTS.md` amendment that comes with it, and nothing here enables ACT: ACT stays DISABLED until the owner's reviewed commit of a contract that authorizes it. No code lane starts until the owner approves this PLAN. The pilot PLAN ([`docs/act-pilot-plan.md`](act-pilot-plan.md)) stays the authority for every path and gate it already governs; PLAN-2 adds to it and changes it only where this document says so. No live run, cloud call or spend is authorized by this document.

## 1. The decision this PLAN implements

The owner said:

> "Relax ALL ACT rules, as we have well defined behaviors and governed policies. This tool becomes useful only if it can act, discover, plan, build and deploy a well architected Landing Zone"

and answered the scoping questions (6511236052):

1. **Scope:** the full generated, well-architected landing zone (LZ), not only a canary, in every environment the contract authorizes, promoted DEV → QA → PROD with the existing promotion evidence.
2. **Initiation:** the tool or agent may discover, plan, build and seal, then run the apply itself, only after a person signs that exact sealed plan with an allowlisted key. Agents never hold approver keys.
3. **Mandatory controls:** the contract's `authorize` (the owner's reviewed contract, default deny); sealed plans with a drift check; the PROD two-person rule (two approvers, neither the requester).
4. **Kept:** the kill switch and the single-use ledger.

What PLAN-2 reads as **unchanged** because the decision did not name it and the five kept controls depend on it (section 11, item U3, asks the owner to confirm): separate engine identities and no credential inheritance; state locking; real-engine qualification evidence; the product-commit binding of a seal; approval expiry and nonces; encrypted evidence; the typed phrases at every step a **person** performs; the protected classes of a cleanup; the console's job table never running an apply; `src/cli/ui-channel.ts` as the console's only bridge to `src/apply`.

## 2. Definitions

- **Full LZ plan:** one sealed plan for one environment's target that creates the generated landing-zone project, every resource of it, inside the blast-radius bounds (section 6). It is not a canary: its contract states a scope of types and maximum counts, not exact counts.
- **Agent channel (`AGENT`):** a third value of `PilotChannel`, beside `CLI` and `UI`. A workflow sealed in it is applied by the **apply broker** on behalf of an agent, after the human signatures it requires exist. Section 5 defines it.
- **Apply broker:** a new, separately started process (`./alz apply-broker`, started by a person) that runs under its own operating-system account, holds the engine identities' credential sources, owns the evidence directory, the ledger, the nonce store and the kill-switch path, and is the only thing that calls the driver for the `AGENT` channel. Agents talk to it only through its typed request queue; they never import `src/apply`.
- **Signer:** a person whose Ed25519 public key is on the contract's allowlist: the requester, or an approver. An agent is never a signer.
- **Promotion:** the same release identity applied DEV, then QA, then PROD, each stage needing a successful (and, under PLAN-2, verified) apply of the stage before.

## 3. User journey

| Step | Who | Channel | What happens | Evidence |
| --- | --- | --- | --- | --- |
| 1. Discover | agent (read-only) | none | Read-only discovery under the DISCOVERY identity (`src/discovery`, `src/observe`), plus the target emptiness check (section 6.4). | discovery record, emptiness result |
| 2. Plan | agent | none | The design and the plan of the LZ from the discovery and the contract's scope (`src/design`). No credentials beyond DISCOVERY. | design record |
| 3. Build | agent | none | The LZ project is generated into a committed, reviewed project directory (section 10, gap G-30: no full generator exists today). The product never seals uncommitted code (`SOURCE_UNVERIFIED`). | commit id, manifest |
| 4. Seal | broker, on the agent's request | `AGENT` | `prepare` then `seal` with `channel: "AGENT"`, the requester **id** the agent names, and no request signature. The engine plans, the full-LZ scope judge (section 6) and the spend bound (section 7) run, and the sealed plan is stored as a **candidate**. | sealed candidate, review bundle |
| 5. Human sign | requester, then approvers | `CLI` or `UI` (a person) | `./alz apply request` (new): the requester reviews the bundle and signs the request (`REQUEST` domain) with their own key, typing `REQUEST AGENT <env> <artifact12>`. `./alz apply approve`: each approver reviews and signs (`APPLY` domain), typing `APPROVE AGENT <env> <artifact12>`. The prompts say plainly that an agent will start the apply without any further confirmation. | signed request, signed approvals |
| 6. Agent apply | broker, on the agent's request | `AGENT` | The agent submits the artifact hash and the signed approvals. The broker runs the driver: every gate of the pilot, plus the drift check (section 8). The engine runs once. | encrypted apply evidence, ledger entry |
| 7. Observe | broker, on the agent's request | `AGENT` (read-only) | The independent observation, as today (`./alz apply observe`). | observation record |
| 8. Promote | agent requests, people sign | as steps 4 to 7 | QA, then PROD: a new seal for the next target with the same release identity, new signatures (PROD: requester plus two approvers, neither the requester), then apply. | promotion evidence |
| 9. Cleanup | a person | `CLI` or `UI` | Unchanged from the pilot in PLAN-2 phase 1: proposal, signatures, typed phrases, `verify-cleanup`, report. An agent does not start a cleanup (section 11, Q6). | cleanup evidence, lifecycle report |

What remains a human act, always: committing the contract (and so the allowlist, the scope, the spend bounds, `authorize`); every signature; every typed phrase; starting the broker; removing the kill switch; qualification attestation; `record-live`, `record-recovery` and release admission; reconciling an interrupted run; every cleanup and removal in phase 1.

## 4. Acceptance criteria

1. With no contract, or an empty `authorize`, every `AGENT` request is `ACT_DISABLED` and nothing is planned, reserved or consumed.
2. An `AGENT` seal or apply runs only when the contract's `authorize` lists the new operation `AGENT_APPLY` for that environment (default deny), in addition to `APPLY`. Removing `AGENT_APPLY` stops every unconsumed `AGENT` artifact with `ACT_AUTHORIZATION_CHANGED`.
3. An `AGENT` apply needs a verified request signature by an allowlisted person and the environment's verified approval quorum over the exact artifact hash, which binds the channel; without them `REQUESTER_SIGNATURE_MISSING`, `APPROVAL_INSUFFICIENT` or the existing approval refusals, and nothing is consumed.
4. In PROD the requester plus two distinct approvers are required, neither approver the requester by id or key (`APPROVER_IS_REQUESTER`), unchanged.
5. An artifact sealed in `AGENT` cannot be applied through `CLI` or `UI`, and an artifact sealed in `CLI` or `UI` cannot be applied through `AGENT` (`CHANNEL_MISMATCH`), before anything is consumed.
6. A full LZ plan seals only when every managed change is a plain create within the contract's scope (section 6); any update, delete, replace, import, move, forget, refused class or count above the bound is refused before anything is stored.
7. The drift check (section 8) runs immediately before the ledger reservation; any difference refuses with `DRIFT_DETECTED` and consumes nothing.
8. The kill switch, when present or unreadable, refuses every `AGENT` request and stops a running engine; the agent cannot remove it, because the broker's account owns its path.
9. An artifact applies once (`ARTIFACT_ALREADY_APPLIED`); an interrupted run stays `RESERVED` and is reconciled by a person, never resumed by the agent.
10. A seal whose upper-bound monthly cost exceeds the contract's environment ceiling is refused (`SPEND_BOUND_EXCEEDED`), and readiness is not READY without a verified budget alert (section 7).
11. Evidence of an `AGENT` run names the channel, the agent principal, the broker host, the requester, the approvers and the drift result, and release admission accepts it only for a path whose contract authorized `AGENT_APPLY`.
12. Every item above has a positive, negative, interrupted and unauthorized test (section 10), labeled SYNTHETIC where it uses a fake engine. Synthetic evidence is never presented as live provider qualification.

## 5. The agent channel

### 5.1 Trust boundary (precondition, not an option)

The pilot's controls assume the person and the product share one operating-system account. An agent under that same account could read a 0600 approver key file (`readApproverKey`, `src/cli/apply.ts`), delete or edit the ledger and nonce store, remove the kill switch, commit a contract change locally (the product checks that the contract is committed, not that it was reviewed: `docs/act-pilot-plan.md`, item 9), or use the APPLY credentials directly and skip the driver. A pseudo-terminal also satisfies `HUMAN_TERMINAL_REQUIRED`. So PLAN-2 makes these **preconditions** of the `AGENT` channel, checked by the broker at start and on every request, each refusing `AGENT_BOUNDARY_UNSAFE`:

1. The broker runs under an operating-system account distinct from the agent's; the evidence directory, ledger, nonce store, kill-switch path, contract checkout and identity credential sources are owned by the broker's account and not writable (credential sources: not readable) by the agent's account.
2. Approver and requester private keys are never on a filesystem the agent's account can read. The owner chooses the mechanism (section 11, Q3): a separate signing machine, or non-exportable keys.
3. The agent's request carries no credential, path, flag or argument list: a closed, typed request (5.3) the broker validates.
4. The contract the broker loads must be a commit reachable from the protected default branch of the reviewed repository, fetched by the broker, and (owner's choice, Q4) signed with an owner key; a contract committed only locally is refused for `AGENT` with `CONTRACT_NOT_REVIEWED`. The `CLI` and `UI` channels keep today's rule.

### 5.2 What the agent proves, and how it is bound

The agent proves nothing by itself. The broker proves, from the sealed plan and files the agent cannot forge:

- the **request signature**: `verifyRequestSignature` over the artifact hash, the environment, the requester id bound in that hash, and a nonce, by an allowlisted key whose entry names the environment;
- the **approval set**: `verifyApprovalSet` over the artifact hash, environment, exact target, expiry (`maxApprovalAgeMinutes`, at most 1440) and one-time nonces, with the per-environment quorum and `REQUESTER_MAY_APPROVE`;
- the **channel**: `AGENT` is a sealed field, so it is inside the artifact hash every signer signs. A signature therefore authorizes this exact plan to be started by the broker for an agent, and nothing else.

`SealedPlan.request` is outside the artifact-hash fields (`src/apply/seal.ts`), so the request signature can be attached after the seal without changing the artifact hash; the candidate is stored without it and is never applicable without it.

### 5.3 Typed interfaces (proposed)

```ts
type PilotChannel = "CLI" | "UI" | "AGENT";
type ActOperation = "APPLY" | "CLEANUP" | "REMOVE" | "AGENT_APPLY";   // AGENT_APPLY: default deny, listed per environment

// What an agent may submit to the broker's queue. Closed: any other key is refused (AGENT_REQUEST_INVALID).
type AgentRequest =
  | { kind: "SEAL"; requestId: string; agentId: string; environment: ApplyEnvironment; projectRef: { commit: string; path: string }; requesterId: string }
  | { kind: "APPLY"; requestId: string; agentId: string; artifactSha256: string; approvals: SignedApproval[] }
  | { kind: "OBSERVE"; requestId: string; agentId: string; artifactSha256: string }
  | { kind: "STATUS"; requestId: string; agentId: string };

// Replaces HumanInvocation for the AGENT channel only. Built by the broker, never by the agent.
type AgentInvocation = { channel: "AGENT"; agentId: string; brokerHost: string; brokerAccount: string; requestId: string; receivedAt: string };

// The broker's answer. Never a credential, a plan byte or a key.
type AgentResult = { requestId: string; ok: true; artifactSha256?: string; outcome?: ApplyOutcome } | { requestId: string; ok: false; code: ApplyRefusalCode; message: string };
```

The contract gains `agents: { id: string; environments: ApplyEnvironment[] }[]` (default none). An `agentId` not listed for the environment is `AGENT_NOT_ALLOWED`. An agent id may never equal an approver id (case-insensitive), checked at load (`CONTRACT_INVALID`).

### 5.4 CHANNEL_MISMATCH, the ledger and the kill switch

- `seal` and `apply` of an `AGENT` artifact run only in the broker. `request` and `approve` of an `AGENT` artifact run only in `CLI` or `UI`, because they are human acts, and they show the channel to the signer; `request` refuses an artifact whose channel is not `AGENT`, because a `CLI` or `UI` seal already carries its requester's signature. `apply` through `CLI` or `UI` of an `AGENT` artifact, and through `AGENT` of a `CLI` or `UI` artifact, is `CHANNEL_MISMATCH` before anything is consumed (`src/apply/driver.ts` today compares `sealed.channel` with the request's channel; it gains the third value).
- The ledger is unchanged: exclusive `RESERVED` create before the engine runs, finalized once (`src/apply/ledger.ts`); the nonce store is unchanged (`src/apply/nonces.ts`). Both live under the broker's account.
- The kill switch is the contract's `killSwitchPath`, resolved under the broker's checkout, read before every request, while the engine runs (`killPollMs`) and before any consumption. Only the owner removes it.

### 5.5 What the agent may never do

Sign; hold, read or ask for any private key; type, answer, pre-answer or simulate any phrase or dialog; write or commit the contract, the allowlist, `authorize`, the scope or the spend bounds; create, remove or edit the kill switch, the ledger, the nonce store or evidence; hold or read an engine identity's credentials; pass a flag, path or argument list to the broker; choose a target the contract does not state; re-request a consumed or reserved artifact; resume an interrupted run; start a cleanup, a removal, a qualification, `record-live`, `record-recovery` or release admission; apply anything not sealed in `AGENT`; reach `src/apply`, `src/cli/apply.ts` or `src/cli/ui-channel.ts` by import (`test/apply-boundary.test.ts` keeps holding).

## 6. Sealing a full LZ plan: change types and blast radius

### 6.1 Change types

- **Greenfield creates only.** Owner decision E1 made APPLY seals create-only, and owner decision 2026-10-28 (6480066863) dropped brownfield preview. PLAN-2 keeps both: every managed `resource_changes` entry must be exactly `["create"]`, not an import or move; a data source may be `read` or `no-op`. Updates, deletes, replaces, imports, moves and forgets are refused (`RESOURCE_NOT_IN_SCOPE`).
- **Brownfield is excluded.** A target that already holds resources the plan would collide with fails the emptiness check (6.4).
- **Day-2 changes are excluded.** Changing an applied LZ (an update or a replace) needs a later PLAN (Q10). A re-seal after a partial apply is allowed only if it is again pure creates.

### 6.2 The scope replaces the canary for a full LZ

A target takes either today's `canary` (exact counts, unchanged) or a new `scope`, never both:

```json
"scope": {
  "resources": [{ "type": "aws_vpc", "max": 3 }, { "type": "aws_kms_key", "max": 5 }],
  "maxCreates": 400,
  "monthlyCeilingUsd": 750
}
```

Each type is an exact engine type (`EngineSpec.canaryTypeOk`, no wildcard), named once, with an integer `max` of at least 1; `maxCreates` bounds the total. A plan may create any count from 0 to `max` of a listed type and nothing else.

### 6.3 Hard bounds no contract can widen (code constants)

- One target per environment: one AWS member account, one Azure subscription, one GCP project, as today; organization, tenant, management-group, folder and billing-scope types are refused for every engine (`REFUSED_CLASS`), so a full LZ under PLAN-2 is a per-environment landing zone, not an organization-wide one (Q2).
- No long-lived credentials: IAM users, access keys, login profiles, service-account keys and their equivalents are refused.
- The provider-configuration judge, region and location checks (`assertProviderConfig`, `assertPlannedLocations`), the refused Terraform constructs (`src/apply/terraform-constructs.ts`) and the unit tag checks stay as they are.
- A `scope` is refused on the `GCP_API` engine, which creates one topic per request by design.

### 6.4 Emptiness check

Before an `AGENT` seal, the DISCOVERY identity sweeps the target by the run's unit tag and by every scope type: anything found that the plan would also create, or any resource tagged with the unit, refuses with `TARGET_NOT_EMPTY`. Discovery is not a complete inventory (`docs/lz-live-journey.md`), so this check reduces collisions; it does not prove there are none.

## 7. Spend bounds

Today readiness reports financial controls as `UNVERIFIED` and advisory (`src/apply/readiness.ts`), and the contract has no cost field. PLAN-2:

1. `scope.monthlyCeilingUsd` per environment is required for a `scope` target.
2. The contract states a reviewed per-type monthly unit-cost ceiling (`unitCostUsd` beside each type, or one owner-reviewed price table file bound by hash); the seal computes the upper bound `sum(count × unitCostUsd)` and refuses above the ceiling (`SPEND_BOUND_EXCEEDED`). A type without a unit cost is refused (`SPEND_UNKNOWN`). This is a bound the owner states, not a price estimate.
3. Readiness becomes a gate for `AGENT`: the DISCOVERY identity must read an existing budget with an alert at or below the ceiling on the target (AWS Budgets, Azure Consumption budget, GCP billing budget), or the request is `SPEND_CONTROL_MISSING`. The `CLI` and `UI` channels keep the advisory report unless the owner decides otherwise (Q7).

## 8. Drift check

The sealed plan already refuses a stale state (`PLAN_STALE`), a moved target, a changed contract or authorizing entry, another product commit and another engine binary. PLAN-2 adds, for every `AGENT` apply and for every full-LZ apply in any channel, after the signatures verify and before the ledger reservation: a fresh refresh plan under the same identities, whose redacted change list must equal the sealed one exactly, and a fresh emptiness check (6.4). A difference is `DRIFT_DETECTED`; nothing is reserved or consumed, and a new seal and new signatures are needed.

## 9. Failure, interruption and recovery

| Event | Behavior |
| --- | --- |
| Refusal before reservation | Nothing consumed; the broker returns the code; the agent may seal a new candidate, never reuse signatures. |
| Kill switch during the engine run | The engine is stopped with its grace period, the outcome is recorded, the ledger is finalized; the agent cannot retry that artifact. |
| Broker crash or host loss | The ledger stays `RESERVED`; the broker refuses new `AGENT` work while any reservation is held; a person reconciles it (`record-recovery`), never the agent. |
| Partial apply of a full LZ | Outcome `PARTIAL` with the engine's own result and the state; no automatic rollback; the agent may observe; a person decides between a new pure-create seal for the remainder and a cleanup. |
| Approvals expire before apply | `APPROVAL_EXPIRED`; nothing consumed. |
| Contract or `authorize` changed after signing | `ACT_AUTHORIZATION_CHANGED`; nothing consumed. |
| Promotion evidence missing | `PROMOTION_EVIDENCE_MISSING`; nothing consumed. |

### Full-LZ cleanup

- **Deletion unit:** one environment's state container (the contract's backend and workspace), named by the unit tag scheme, as today (`docs/act-pilot-plan.md`, cleanup item 6).
- **Who:** a person, through the existing proposal, signature and typed-phrase flow, with the PROD quorum.
- **Protected objects:** unchanged: the state backend, the pilot's own identities, deployment history, every resource group, containers, and the CDK sentinel. A full LZ creates identity objects and resource groups, so under today's rules its cleanup cannot reach `COMPLETE` (`PROTECTED_IDENTITY`, `RETAINED_GROUP`). PLAN-2 does not change that; it asks the owner (Q8) whether run-created identities (other than the four engine identities) and run-created groups may be proposed, with ownership proven by plan, state and observation as run-created policies are today.
- **Leftovers:** reported by class and owner; types outside the reviewed AWS leaf allowlist stay `TYPE_UNREVIEWED`; retention-bound resources (log archive buckets with object lock, KMS keys in their pending-deletion window) are reported `DELETION_PENDING` or retained, never "deleted". Full environment retirement stays reported outstanding.

## 10. Gap inventory

Every row was checked against the code at `423c966`. "Lane" is the proposed owner lane; "Order" is the sequence (same number: may run in parallel on disjoint paths). Tests: **P** positive, **N** negative, **I** interrupted, **U** unauthorized. Shared files (`src/apply/types.ts`, `src/apply/contract.ts`, `config/production-deployment-contract.yaml`, `src/qualification/release-admission.ts`) have one serialized integrator.

| # | File or module | Today (verified) | Change needed | Lane | Order | Risk | Tests that must prove it |
| --- | --- | --- | --- | --- | --- | --- | --- |
| G-01 | `AGENTS.md`, `docs/act-plan-2.md`, `.claude/skills/act-pilot/SKILL.md` | "agents never initiate an apply" | This PR | PLAN-2 | 0 | High (policy) | owner review; `npm run check` |
| G-02 | `docs/act-pilot-plan.md` | sole ACT PLAN, "changing its scope requires a new PLAN" | Status line pointing to PLAN-2 for full-LZ and `AGENT`; out-of-scope list ("Enabling ACT for agents") amended | DOC | 1 | Low | doc review |
| G-03 | `src/apply/types.ts` | `PilotChannel = "CLI" \| "UI"`; `ActOperation` has three values | add `AGENT`, `AGENT_APPLY`, `AgentRequest`, `AgentInvocation`, refusal codes (`AGENT_NOT_ALLOWED`, `AGENT_BOUNDARY_UNSAFE`, `AGENT_REQUEST_INVALID`, `CONTRACT_NOT_REVIEWED`, `DRIFT_DETECTED`, `TARGET_NOT_EMPTY`, `RESOURCE_NOT_IN_SCOPE`, `REFUSED_CLASS`, `SPEND_BOUND_EXCEEDED`, `SPEND_UNKNOWN`, `SPEND_CONTROL_MISSING`) | INT | 1 | High | type check; N: unknown channel refused by `verifySealedPlan` |
| G-04 | `src/apply/contract.ts`, `src/apply/contract-check.ts` | `authorize` ops APPLY/CLEANUP/REMOVE; `canary` required for APPLY (`CANARY_ALLOWLIST_MISSING`) | `AGENT_APPLY` op; `agents` list; `scope` (exclusive with `canary`); unit costs and ceiling; agent id never an approver id | INT | 1 | High | P: valid scope contract loads; N: both canary and scope, wildcard type, agent id equal to approver id; U: `AGENT_APPLY` absent is `ACT_NOT_AUTHORIZED` |
| G-05 | `src/apply/contract.ts` `DEV_ONLY_PATHS` | Bicep, GCP Terraform, GCP API are DEV only | Phase 1 keeps them; full-LZ three-stage only for AWS Terraform, Azure Terraform, AWS CDK; `scope` refused on GCP_API | INT | 1 | Medium | N: three-stage Bicep stays `CONTRACT_INVALID`; N: scope on GCP_API refused |
| G-06 | `src/apply/canary.ts`, `src/apply/engines/terraform.ts` `assertPlanInCanary`, `engines/cdk.ts`, `engines/bicep.ts` | exact counts, create only | add the scope judge (create only, max counts, `maxCreates`, `REFUSED_CLASS` constants) beside the canary judge, at seal, qualification plan and apply re-derivation | SCOPE | 2 | High | P: LZ plan within scope; N: update, replace, import, move, forget, count above max, refused class, IAM user; I: none; U: scope from an unreviewed contract |
| G-07 | `src/apply/seal.ts` | seal needs the requester's key; "a throwaway plan has no signature and can never be stored" | store an `AGENT` candidate without `request`; attach the request signature later without changing `artifactSha256` | CHAN | 2 | High | P: candidate then request verifies; N: candidate applied without request is `REQUESTER_SIGNATURE_MISSING`; U: request by an unlisted key |
| G-08 | `src/cli/apply.ts` | `seal` signs the request inline; `approve` phrase `APPROVE <env> <hash12>`; `HUMAN_TERMINAL_REQUIRED` | new `request` subcommand (`REQUEST AGENT <env> <hash12>`); `approve` of an `AGENT` artifact asks `APPROVE AGENT ...` and states that an agent will start it | CHAN | 3 | Medium | P: request and approve of an AGENT artifact; N: wrong phrase; U: key not 0600, approver is requester in PROD |
| G-09 | `src/cli/agent-broker.ts` (new), `alz` launcher | none | the broker: separate account checks (5.1), typed queue, builds `AgentInvocation`, calls the driver; refuses while a reservation is held | CHAN | 3 | High | P: seal and apply round trip (SYNTHETIC); N: same-account start is `AGENT_BOUNDARY_UNSAFE`; I: crash leaves `RESERVED` and later requests refused; U: unlisted agent id |
| G-10 | `src/apply/driver.ts` `admit`, `src/teardown/driver/human.ts` | every seal and apply requires `checkHumanInvocation` (`interactiveSession: true`) | per-channel admission: `HumanInvocation` for CLI/UI, `AgentInvocation` plus `AGENT_APPLY` for AGENT; the teardown driver's human check unchanged | CHAN | 3 | High | P: agent invocation admitted only with AGENT_APPLY; N: agent invocation with CLI channel; U: human invocation forged by an agent request (closed schema) |
| G-11 | `src/apply/driver.ts` channel checks (`CHANNEL_MISMATCH` at seal reuse, apply, cleanup) | two channels | three channels, the matrix of 5.4 | CHAN | 3 | High | N: all six cross-channel pairs; U: AGENT cleanup refused in phase 1 |
| G-12 | `src/apply/driver.ts`, engines | `PLAN_STALE` from the engine; no fresh plan before apply | drift check (section 8) before `reserveArtifact` | DRIFT | 4 | High | P: no drift applies; N: changed list is `DRIFT_DETECTED` with nothing consumed; I: kill switch during the drift plan |
| G-13 | `src/apply/prepare.ts` `deriveInputs` | `ENVIRONMENT` inputs bind the variable name, not its value; values are never shown | for `AGENT`, refuse `ENVIRONMENT` and unset inputs: every input comes from committed files, so signers and the release identity cover them (section 11, U6) | CHAN | 3 | High | N: env-var input in an AGENT prepare refused; P: committed tfvars accepted |
| G-14 | `src/apply/contract.ts` `requirePromotionEvidence` | QA needs a SUCCEEDED DEV apply of the same `releaseIdentity`; PROD a SUCCEEDED QA | also require a VERIFIED observation of the earlier stage; per-environment tfvars change `releaseIdentity` (file hashes are inputs), so the project layout must keep environment values in the contract target or a bound overlay | PROMO | 4 | Medium | P: DEV→QA→PROD with verified observations; N: unverified DEV observation; N: different release identity |
| G-15 | `src/apply/contract.ts` `verifyApplyQualification` | evidence is bound to the DEV target; QA/PROD reuse it (`principalPerEnvironment`) | unchanged in phase 1; record the owner's choice whether QA/PROD need their own qualification | PROMO | 4 | Medium | existing tests; new N if the owner requires per-environment evidence |
| G-16 | `src/apply/readiness.ts` | financial controls `UNVERIFIED`, advisory | budget read by DISCOVERY per provider; READY gate for AGENT | SPEND | 4 | Medium | P: budget at ceiling; N: none or higher; U: read denied counts as missing |
| G-17 | spend bound at seal (`src/apply/seal.ts` or a new `src/apply/spend.ts`) | none | upper-bound computation from the contract's unit costs | SPEND | 2 | Medium | P: under ceiling; N: above, unknown type |
| G-18 | emptiness check (`src/apply/observe.ts`, `src/observe/*`) | observation runs after an apply | a pre-seal and pre-apply sweep (6.4) | DRIFT | 4 | Medium | P: empty target; N: tagged or colliding resource; U: denied read fails closed |
| G-19 | `src/apply/evidence.ts`, `src/apply/live-record.ts` | evidence names approvers and `invocation` | add channel, agent id, broker host and account, drift result, spend bound | INT | 4 | Medium | P: evidence validates; N: AGENT evidence without agent id refused |
| G-20 | `src/apply/cleanup-proposal.ts`, `src/observe/run-created-policies.ts`, `src/observe/aws-leaf-types.ts` | identities and groups protected; leaf allowlist small | only after Q8: run-created identity and group proposals; leaf allowlist grows by review; retention classes | CLEAN | 5 | High | P: run-created role proposed; N: engine identity, backend, pre-existing; I: partial cleanup reports pending |
| G-21 | `src/apply/lifecycle-report.ts`, `src/apply/leftovers.ts` | canary-sized runs | full-LZ counts by class and owner; retention states | CLEAN | 5 | Low | P and N on report validation |
| G-22 | `config/production-deployment-contract.yaml`, `src/qualification/production-contract.ts`, `test/production-contract.test.ts` | `initiatedBy: HUMAN_OPERATOR`; a test asserts `AGENT` is refused | add `AGENT_AFTER_HUMAN_SIGNATURE` as an allowed value only together with `AGENT_APPLY`; update that test deliberately, not by relaxing it | INT | 5 | High | N: `AGENT` alone still refused; P: the new value with its binding |
| G-23 | `src/qualification/release-admission.ts`, `config/release/scope.json`, `config/release/status.json`, `docs/release-status.md` | `ACT_RELEASE_PATHS` gates "Owner-supervised DEV apply"; pillar gates moved to v1.1 | new full-LZ gates per path and environment, AGENT evidence admission; regenerate docs with `npm run docs:release` | REL | 6 | Medium | P: admission with AGENT evidence; N: AGENT evidence under a contract without AGENT_APPLY |
| G-24 | `test/apply-boundary.test.ts` | agent-facing roots never reach `src/apply` | keep, and add: the broker is the only module importing the driver besides the CLI; agent modules reach the broker only by its queue schema | CHAN | 3 | High | N: an import from `src/agent` or `src/tools` to the broker or driver fails the test |
| G-25 | `src/agent/act.ts` | `CHANGE` intent returns `ACT_DISABLED` | an `AGENT` request client that writes to the queue, still `ACT_DISABLED` when the broker reports so | AGENT | 4 | Medium | P: queue write; N: no broker; U: ACT_DISABLED surfaced |
| G-26 | `src/cli/ui-channel.ts`, `src/operator-ui/app/pilot/*` | wizard for CLI-equivalent steps | `request` and `approve` of AGENT artifacts in the wizard, with the session token; no agent path through the console | UI | 5 | Medium | P: wizard signs; N: wizard cannot apply an AGENT artifact (`CHANNEL_MISMATCH`) |
| G-27 | `src/evidence-runner/act.ts`, `docs/evidence-runner.md` | guided human stages | an `act-lz:<path>` stage that observes broker runs; it still never starts one | REL | 6 | Low | P: stage reads evidence; N: never starts an apply |
| G-28 | `scripts/release-stage.sh`, `src/cli/release-package.ts`, `.dockerignore` | the field package carries no contract | unchanged; decide whether the broker ships in the field package (Q1) | REL | 6 | Medium | existing `test/release-package-exclusions.test.ts`; new N if the broker is excluded |
| G-29 | `docs/act-pilot-apply.md`, `docs/act-dev-enablement.md`, `docs/act-pilot-walkthrough.md`, `docs/observe-and-cleanup.md` | pilot operations | the AGENT journey and full-LZ operations; edited after open PR #368 (FIX-2) merges, since it touches the first two | DOC | 6 | Low | doc review |
| G-30 | `src/build/*`, `src/design/*`, `src/iac/*` | build is slice-based and synthetic (for example `azure-greenfield-terraform-audit-workspace-v1`, one resource); no generator produces a full applyable LZ project | a full-LZ generator per path that writes a committed project the seal accepts (unit tags, provider config, no refused constructs), or the owner supplies a reviewed LZ project (Q12) | GEN | 2 | High | P: generated project seals within scope (SYNTHETIC); N: generated refused construct is caught by the seal, not trusted |
| G-31 | `bootstrap/aws`, `bootstrap/azure`, `bootstrap/gcp` | APPLY roles sized for the canary types | APPLY permissions for the LZ scope types; owner runs the bootstrap | OWNER + BOOT | 5 | High | bootstrap plan review; N: role without org-level permissions |

**Headline:** 31 gaps: 15 High, 12 Medium, 4 Low. G-01 is this PR.

## 11. Open questions only the owner can answer

- **Q1.** Is the `AGENT` channel for the internal reference build (customer zero) only, as the pilot is, or a product feature that ships in the field package?
- **Q2.** "Full landing zone" per environment (one account, subscription or project, as PLAN-2 proposes) or organization-wide (management account, OUs, SCPs, management groups, Control Tower)? The latter needs organization-level authority and a separate PLAN.
- **Q3.** Key custody: where do signer keys live so that the agent's account cannot read them (a separate signing machine, a hardware key, a cloud KMS signing key with a human-only policy)?
- **Q4.** How the broker proves the contract was reviewed: reachable from the protected default branch only, or also a signed commit verified against an owner key?
- **Q5.** Is an approval of an `AGENT` artifact enough to release it to the agent, or does the owner want a separate signed "execute" statement?
- **Q6.** May the agent later start a signed cleanup through the broker? PLAN-2 phase 1 says no.
- **Q7.** The spend model: owner-stated unit-cost ceilings (proposed) or a price source; and whether the budget gate also applies to `CLI` and `UI`.
- **Q8.** May a cleanup propose run-created identity objects (except the engine identities) and run-created resource groups? Without it a full-LZ cleanup never reports `COMPLETE`.
- **Q9.** Which paths go three-stage for the full LZ: AWS Terraform, Azure Terraform and AWS CDK only (proposed), or also Azure Bicep and GCP Terraform?
- **Q10.** Day-2 changes (updates and replaces of an applied LZ): confirm they are out of PLAN-2 and need their own PLAN.
- **Q11.** Promotion: is a VERIFIED observation of the earlier stage required (proposed), and is there a minimum soak time before QA or PROD?
- **Q12.** The source of the LZ IaC: a product generator (large new lane, G-30) or an owner-reviewed project per path?

## 12. Findings: unsafe or contradictory points in the decision

- **U1 (unsafe without 5.1).** "The agent runs the apply itself" on the operator's machine under the same account defeats every kept control: it can read 0600 key files, delete the ledger and nonces, remove the kill switch, commit a contract locally, or use the APPLY credentials without the driver. PLAN-2 therefore makes the separate broker account and off-host keys preconditions, not options.
- **U2.** `HUMAN_TERMINAL_REQUIRED` (a TTY check) does not distinguish a person from an agent with a pseudo-terminal. Today's rule against agent-initiated applies rests on policy; the signatures and key custody are the real controls, which is why U1 matters.
- **U3 (contradictory wording).** "Relax ALL ACT rules" and the list of five kept controls leave other controls unnamed (separate identities, locking, qualification, approval expiry, product-commit binding, typed phrases at human steps, protected cleanup classes). The kept controls depend on them, so PLAN-2 keeps them; the owner should confirm none is meant to go.
- **U4 (contradiction).** A full LZ conflicts with E1's exact canary counts (resolved by `scope`) and with the protected cleanup classes (a full-LZ cleanup cannot reach `COMPLETE`, Q8).
- **U5.** "Discover, plan, build" is not yet real for a full LZ: discovery is partial and the build is synthetic and single-resource (G-30). A greenfield plan on incomplete discovery can collide and partially apply; the emptiness and drift checks reduce this, they do not remove it.
- **U6 (unsafe today for AGENT).** An `ENVIRONMENT` input's value is bound in the plan but not in the release identity and is never shown to signers, so an agent could choose a different value in PROD than in DEV while promotion still matches. G-13 refuses environment inputs in the `AGENT` channel.

## 13. Process

PLAN (this PR, owner review) → DO lanes in the order of section 10, each through the normal steward workflow with its own check-in on #39, disjoint paths, and one serialized integrator for the shared files → CONVERGE on SYNTHETIC end-to-end journeys for each path and channel → ACT (merge) per lane. Enabling ACT stays the owner's reviewed contract commit, and every live run, spend and teardown stays separately authorized by the owner.
