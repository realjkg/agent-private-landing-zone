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
- **Agent channel (`AGENT`):** a third value of `PilotChannel`, beside `CLI` and `UI`. A workflow sealed in it is applied by the **apply service** on behalf of an agent, after the human signatures it requires exist. Section 5 defines it.
- **Apply service:** a new, separately started process (`./alz apply-service`, started by a person) that runs under its own operating-system account, holds the engine identities' credential sources, owns the evidence directory, the ledger, the nonce store and the kill-switch path, and is the only thing that calls the driver for the `AGENT` channel. Agents talk to it only through its typed request queue; they never import `src/apply`. It is not the existing tool broker (`src/tools/broker.ts`), which stays unable to reach `src/apply` (`test/apply-boundary.test.ts`); the new process is named "apply service" everywhere to keep the two apart.
- **Signer:** a person whose Ed25519 public key is on the contract's allowlist: the requester, or an approver. An agent is never a signer.
- **Promotion:** the same release identity applied DEV, then QA, then PROD, each stage needing a successful (and, under PLAN-2, verified) apply of the stage before.

## 3. User journey

| Step | Who | Channel | What happens | Evidence |
| --- | --- | --- | --- | --- |
| 1. Discover | agent (read-only) | none | Read-only discovery under the DISCOVERY identity (`src/discovery`, `src/observe`), plus the target emptiness check (section 6.4). | discovery record, emptiness result |
| 2. Plan | agent | none | The design and the plan of the LZ from the discovery and the contract's scope (`src/design`). No credentials beyond DISCOVERY. | design record |
| 3. Build | agent | none | The LZ project is generated into a committed, reviewed project directory (section 10, gap G-30: no full generator exists today). The product never seals uncommitted code (`SOURCE_UNVERIFIED`). | commit id, manifest |
| 4. Seal | apply service, on the agent's request | `AGENT` | `prepare` then `seal` with `channel: "AGENT"`, the requester **id** the agent names, and no request signature. The engine plans, the full-LZ scope judge (section 6) and the spend bound (section 7) run, and the sealed plan is stored as a **candidate**. | sealed candidate, review bundle |
| 5. Human sign | requester, then approvers | `CLI` or `UI` (a person) | `./alz apply request` (new): the requester reviews the bundle and signs the request (`REQUEST` domain) with their own key, typing `REQUEST AGENT <env> <artifact12>`. `./alz apply approve`: each approver reviews and signs (`APPLY` domain), typing `APPROVE AGENT <env> <artifact12>`. The prompts say plainly that an agent will start the apply without any further confirmation. | signed request, signed approvals |
| 6. Agent apply | apply service, on the agent's request | `AGENT` | The agent submits the artifact hash and the signed approvals. The apply service runs the driver: every gate of the pilot, plus the drift check (section 8). The engine runs once. | encrypted apply evidence, ledger entry |
| 7. Observe | apply service, on the agent's request | `AGENT` (read-only) | The independent observation, as today (`./alz apply observe`). | observation record |
| 8. Promote | agent requests, people sign | as steps 4 to 7 | QA, then PROD: a new seal for the next target with the same release identity, new signatures (PROD: requester plus two approvers, neither the requester), then apply. | promotion evidence |
| 9. Cleanup | a person | `CLI` or `UI` | Unchanged from the pilot in PLAN-2 phase 1: proposal, signatures, typed phrases, `verify-cleanup`, report. An agent does not start a cleanup (section 11, Q6). | cleanup evidence, lifecycle report |

What remains a human act, always: committing the contract (and so the allowlist, the scope, the spend bounds, `authorize`); every signature; every typed phrase; starting the apply service; removing the kill switch; qualification attestation; `record-live`, `record-recovery` and release admission (against the apply service's evidence, section 9); reconciling an interrupted run; every cleanup and removal in phase 1.

## 4. Acceptance criteria

1. With no contract, or an empty `authorize`, every `AGENT` request is `ACT_DISABLED` and nothing is planned, reserved or consumed.
2. An `AGENT` seal or apply runs only when the contract's `authorize` lists the new operation `AGENT_APPLY` for that environment (default deny), in addition to `APPLY`. Removing `AGENT_APPLY` stops every unconsumed `AGENT` artifact with `ACT_AUTHORIZATION_CHANGED`.
3. An `AGENT` apply needs a verified request signature by an allowlisted person and the environment's verified approval quorum over the exact artifact hash, which binds the channel; without them `REQUESTER_SIGNATURE_MISSING`, `APPROVAL_INSUFFICIENT` or the existing approval refusals, and nothing is consumed.
4. In PROD the requester plus two distinct approvers are required, neither approver the requester by id or key (`APPROVER_IS_REQUESTER`), unchanged.
5. An artifact sealed in `AGENT` cannot be applied through `CLI` or `UI`, and an artifact sealed in `CLI` or `UI` cannot be applied through `AGENT` (`CHANNEL_MISMATCH`), before anything is consumed.
6. A full LZ plan seals only when every managed change is a plain create within the contract's scope (section 6); any update, delete, replace, import, move, forget, refused class or count above the bound is refused before anything is stored.
7. The drift check (section 8) runs immediately before the ledger reservation; any difference refuses with `DRIFT_DETECTED` and consumes nothing.
8. The apply service's kill switch (5.4), when present or unreadable, refuses every `AGENT` request and stops a running engine; an agent may create it through a `STOP` request (a stop is always safe), and cannot remove or edit it, because the apply service's account owns its path.
9. An artifact applies once (`ARTIFACT_ALREADY_APPLIED`); an interrupted run stays `RESERVED` and is reconciled by a person, never resumed by the agent.
10. A seal whose upper-bound monthly cost exceeds the contract's environment ceiling is refused (`SPEND_BOUND_EXCEEDED`), and readiness is not READY without a verified budget alert (section 7).
11. Evidence of an `AGENT` run names the channel, the agent principal, the apply service host, the requester, the approvers and the drift result, and release admission accepts it only for a path whose contract authorized `AGENT_APPLY`.
12. Every item above has a positive, negative, interrupted and unauthorized test (section 10), labeled SYNTHETIC where it uses a fake engine. Synthetic evidence is never presented as live provider qualification.

## 5. The agent channel

### 5.1 Trust boundary (precondition, not an option)

The pilot's controls assume the person and the product share one operating-system account. An agent under that same account could read a 0600 approver key file (`readApproverKey`, `src/cli/apply.ts`), delete or edit the ledger and nonce store, remove the kill switch, commit a contract change locally (the product checks that the contract is committed, not that it was reviewed: `docs/act-pilot-plan.md`, item 9), or use the APPLY credentials directly and skip the driver. A pseudo-terminal also satisfies `HUMAN_TERMINAL_REQUIRED`. So PLAN-2 makes these **preconditions** of the `AGENT` channel, checked by the apply service at start and on every request, each refusing `AGENT_BOUNDARY_UNSAFE`:

1. **Accounts.** The apply service runs under an operating-system account distinct from the agent's; the evidence directory, the evidence key, the ledger, the nonce store, the kill-switch path, the contract checkout and the identity credential sources are owned by the apply service's account and not writable (credential sources and the evidence key: not readable) by the agent's account.
2. **Signer keys.** Approver and requester private keys are never on a filesystem the agent's account can read. The owner chooses the mechanism (section 11, Q3): a separate signing machine, or non-exportable keys.
3. **Closed requests.** The agent's request carries no credential, path, flag or argument list: a closed, typed request (5.3) the apply service validates.
4. **Owner review is proved, not inferred.** Agents may merge reviewed heads to `main` under the `steward` skill, so "reachable from the protected default branch" does not prove that the owner reviewed a commit. For `AGENT`, the contract and the product code of the apply service and of the signer CLI must come from a commit whose owner review is proved by at least one of (Q4 chooses; one is required, not optional): (a) a commit signed with an owner key the agent cannot read, verified against an allowed-signers file the apply service's account owns; (b) enforced owner review in the repository settings (branch protection with required code-owner review by the owner) on `config/act-pilot-contract.json`, `src/apply/**`, `src/cli/apply.ts`, `src/cli/apply-service.ts` and the `alz` launcher, which the apply service confirms when it fetches. Otherwise the `AGENT` channel refuses with `CONTRACT_NOT_REVIEWED`. The `CLI` and `UI` channels keep today's rule.
5. **Code and tool integrity of the apply service.** The apply service runs only a product build of such a commit, installed where the agent's account cannot write: its checkout, `dist/`, `node_modules`, the `alz` launcher, and its own `PATH` and environment (set by the person who starts it, never inherited from the agent). The engine binaries (the approved tool directories), the Terraform provider plugin cache and provider mirrors, and the cloud CLIs are covered too, because provider plugins run under the PLAN and APPLY identities. A writable or unverified item refuses `AGENT_BOUNDARY_UNSAFE`.
6. **Signer tool integrity.** `request` and `approve` for an `AGENT` artifact run only from a build that meets item 5, on the signer's machine or account. The signing display is part of key custody (Q3): a non-exportable key signs whatever hash the code hands it, so a tampered CLI could show one bundle and sign another.
7. **Agent identity is derived.** The apply service derives the agent principal itself, from the operating-system peer credentials of the queue connection (for example a Unix socket's peer user id) or from per-agent queue ownership, and maps it to the contract's `agents` list. A request never names its own agent.

### 5.2 What the agent proves, and how it is bound

The agent proves nothing by itself. The apply service proves, from the sealed plan and files the agent cannot forge:

- the **request signature**: `verifyRequestSignature` over the artifact hash, the environment, the requester id bound in that hash, and a nonce, by an allowlisted key whose entry names the environment;
- the **approval set**: `verifyApprovalSet` over the artifact hash, environment, exact target, expiry (`maxApprovalAgeMinutes`, at most 1440) and one-time nonces, with the per-environment quorum and `REQUESTER_MAY_APPROVE`;
- the **channel**: `AGENT` is a sealed field, so it is inside the artifact hash every signer signs. A signature therefore authorizes this exact plan to be started by the apply service for an agent, and nothing else.

`SealedPlan.request` is outside the artifact-hash fields (`src/apply/seal.ts`), so the request signature can be attached after the seal without changing the artifact hash; the candidate is stored without it and is never applicable without it.

### 5.3 Typed interfaces (proposed)

```ts
type PilotChannel = "CLI" | "UI" | "AGENT";
type ActOperation = "APPLY" | "CLEANUP" | "REMOVE" | "AGENT_APPLY";   // AGENT_APPLY: default deny, listed per environment

// What an agent may submit to the apply service's queue. Closed: any other key is refused (AGENT_REQUEST_INVALID).
type AgentRequest =
  // The agent is never named in the request: the apply service derives it (5.1, item 7).
  | { kind: "SEAL"; requestId: string; environment: ApplyEnvironment; projectRef: { commit: string; path: string }; requesterId: string }
  | { kind: "APPLY"; requestId: string; artifactSha256: string; approvals: SignedApproval[] }
  | { kind: "OBSERVE"; requestId: string; artifactSha256: string }
  | { kind: "STATUS"; requestId: string }
  | { kind: "STOP"; requestId: string };   // creates the apply service's kill switch; nothing removes it but the owner

// Replaces HumanInvocation for the AGENT channel only. Built by the apply service, never by the agent; agentId comes from the peer credentials.
type AgentInvocation = { channel: "AGENT"; agentId: string; serviceHost: string; serviceAccount: string; requestId: string; receivedAt: string };

// The apply service's answer. Never a credential, a plan byte or a key.
type AgentResult = { requestId: string; ok: true; artifactSha256?: string; outcome?: ApplyOutcome } | { requestId: string; ok: false; code: ApplyRefusalCode; message: string };
```

The contract gains `agents: { id: string; environments: ApplyEnvironment[] }[]` (default none). A derived agent principal not listed for the environment is `AGENT_NOT_ALLOWED`. An agent id may never equal an approver id (case-insensitive), checked at load (`CONTRACT_INVALID`).

### 5.4 CHANNEL_MISMATCH, the ledger and the kill switch

- `seal` and `apply` of an `AGENT` artifact run only in the apply service. `request` and `approve` of an `AGENT` artifact run only in `CLI` or `UI`, because they are human acts, and they show the channel to the signer; `request` refuses an artifact whose channel is not `AGENT`, because a `CLI` or `UI` seal already carries its requester's signature. `apply` through `CLI` or `UI` of an `AGENT` artifact, and through `AGENT` of a `CLI` or `UI` artifact, is `CHANNEL_MISMATCH` before anything is consumed (`src/apply/driver.ts` today compares `sealed.channel` with the request's channel; it gains the third value).
- The ledger is unchanged: exclusive `RESERVED` create before the engine runs, finalized once (`src/apply/ledger.ts`); the nonce store is unchanged (`src/apply/nonces.ts`). Both live under the apply service's account.
- **Two kill-switch files, one rule.** The contract's `killSwitchPath` is resolved per checkout, so there are two files: the operator checkout's, which stops the `CLI` and `UI` channels (today's switch), and the apply service's, which stops the `AGENT` channel. The apply service reads its own before every request, while the engine runs (`killPollMs`) and before any consumption; it also reads the operator checkout's when the person who starts it names that checkout, and stops when either exists. A person stops everything by creating both (`./alz apply stop`, gap G-39, creates both where the person can write). An agent may create a kill switch (the operator checkout's where its account can write, the apply service's through a `STOP` request), because a stop is always safe; only the owner removes either, and the code never does.
- **Evidence and promotion.** The apply service's evidence directory holds every `AGENT` run, encrypted with the evidence key its account holds. A person runs `record-live`, `record-recovery` and release admission against it by starting those commands under the apply service's account (gap G-37). Phase 1 does not mix channels within one promotion chain: an `AGENT` QA or PROD apply reads promotion evidence only from the apply service's directory, so a release whose DEV stage ran through `CLI` or `UI` is `PROMOTION_EVIDENCE_MISSING` for an `AGENT` QA, and the reverse (gap G-38; Q13).

### 5.5 What the agent may never do

Sign; hold, read or ask for any private key; type, answer, pre-answer or simulate any phrase or dialog; write or commit the contract, the allowlist, `authorize`, the scope or the spend bounds; remove, edit or bypass a kill switch (creating one, or a `STOP` request, is allowed); write the ledger, the nonce store, the evidence or the evidence key; write the product code, build, launcher, environment, engine binaries or plugin caches the apply service or a signer runs; hold or read an engine identity's credentials; pass a flag, path or argument list to the apply service; choose a target the contract does not state; re-request a consumed or reserved artifact; resume an interrupted run; start a cleanup, a removal, a qualification, `record-live`, `record-recovery` or release admission; apply anything not sealed in `AGENT`; reach `src/apply`, `src/cli/apply.ts` or `src/cli/ui-channel.ts` by import (`test/apply-boundary.test.ts` keeps holding).

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
| Refusal before reservation | Nothing consumed; the apply service returns the code; the agent may seal a new candidate, never reuse signatures. |
| Kill switch during the engine run | The engine is stopped with its grace period, the outcome is recorded, the ledger is finalized; the agent cannot retry that artifact. |
| Broker crash or host loss | The ledger stays `RESERVED`; the apply service refuses new `AGENT` work while any reservation is held; a person reconciles it (`record-recovery`), never the agent. |
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
| G-03 | `src/apply/types.ts` | `PilotChannel = "CLI" \| "UI"`; `ActOperation` has three values | add `AGENT`, `AGENT_APPLY`, `AgentRequest`, `AgentInvocation`, refusal codes (`AGENT_NOT_ALLOWED`, `AGENT_BOUNDARY_UNSAFE`, `AGENT_REQUEST_INVALID`, `CONTRACT_NOT_REVIEWED`, `DRIFT_DETECTED`, `TARGET_NOT_EMPTY`, `RESOURCE_NOT_IN_SCOPE`, `REFUSED_CLASS`, `SPEND_BOUND_EXCEEDED`, `SPEND_UNKNOWN`, `SPEND_CONTROL_MISSING`, `SIGNER_TOOL_UNSAFE`) | INT | 1 | High | type check; N: unknown channel refused by `verifySealedPlan` |
| G-04 | `src/apply/contract.ts`, `src/apply/contract-check.ts` | `authorize` ops APPLY/CLEANUP/REMOVE; `canary` required for APPLY (`CANARY_ALLOWLIST_MISSING`) | `AGENT_APPLY` op; `agents` list; `scope` (exclusive with `canary`); unit costs and ceiling; agent id never an approver id | INT | 1 | High | P: valid scope contract loads; N: both canary and scope, wildcard type, agent id equal to approver id; U: `AGENT_APPLY` absent is `ACT_NOT_AUTHORIZED` |
| G-05 | `src/apply/contract.ts` `DEV_ONLY_PATHS` | Bicep, GCP Terraform, GCP API are DEV only | Phase 1 keeps them; full-LZ three-stage only for AWS Terraform, Azure Terraform, AWS CDK; `scope` refused on GCP_API | INT | 1 | Medium | N: three-stage Bicep stays `CONTRACT_INVALID`; N: scope on GCP_API refused |
| G-06 | `src/apply/canary.ts`, `src/apply/engines/terraform.ts` `assertPlanInCanary`, `engines/cdk.ts`, `engines/bicep.ts` | exact counts, create only | add the scope judge (create only, max counts, `maxCreates`, `REFUSED_CLASS` constants) beside the canary judge, at seal, qualification plan and apply re-derivation | SCOPE | 2 | High | P: LZ plan within scope; N: update, replace, import, move, forget, count above max, refused class, IAM user; I: none; U: scope from an unreviewed contract |
| G-07 | `src/apply/seal.ts` | seal needs the requester's key; "a throwaway plan has no signature and can never be stored" | store an `AGENT` candidate without `request`; attach the request signature later without changing `artifactSha256` | CHAN | 2 | High | P: candidate then request verifies; N: candidate applied without request is `REQUESTER_SIGNATURE_MISSING`; U: request by an unlisted key |
| G-08 | `src/cli/apply.ts` | `seal` signs the request inline; `approve` phrase `APPROVE <env> <hash12>`; `HUMAN_TERMINAL_REQUIRED` | new `request` subcommand (`REQUEST AGENT <env> <hash12>`); `approve` of an `AGENT` artifact asks `APPROVE AGENT ...` and states that an agent will start it | CHAN | 3 | Medium | P: request and approve of an AGENT artifact; N: wrong phrase; U: key not 0600, approver is requester in PROD |
| G-09 | `src/cli/apply-service.ts` (new), `alz` launcher | none | the apply service: separate account checks (5.1), typed queue, builds `AgentInvocation`, calls the driver; refuses while a reservation is held | CHAN | 3 | High | P: seal and apply round trip (SYNTHETIC); N: same-account start is `AGENT_BOUNDARY_UNSAFE`; I: crash leaves `RESERVED` and later requests refused; U: unlisted agent id |
| G-10 | `src/apply/driver.ts` `admit`, `src/teardown/driver/human.ts` | every seal and apply requires `checkHumanInvocation` (`interactiveSession: true`) | per-channel admission: `HumanInvocation` for CLI/UI, `AgentInvocation` plus `AGENT_APPLY` for AGENT; the teardown driver's human check unchanged | CHAN | 3 | High | P: agent invocation admitted only with AGENT_APPLY; N: agent invocation with CLI channel; U: human invocation forged by an agent request (closed schema) |
| G-11 | `src/apply/driver.ts` channel checks (`CHANNEL_MISMATCH` at seal reuse, apply, cleanup) | two channels | three channels, the matrix of 5.4 | CHAN | 3 | High | N: all six cross-channel pairs; U: AGENT cleanup refused in phase 1 |
| G-12 | `src/apply/driver.ts`, engines | `PLAN_STALE` from the engine; no fresh plan before apply | drift check (section 8) before `reserveArtifact` | DRIFT | 4 | High | P: no drift applies; N: changed list is `DRIFT_DETECTED` with nothing consumed; I: kill switch during the drift plan |
| G-13 | `src/apply/prepare.ts` `deriveInputs` | `ENVIRONMENT` inputs bind the variable name, not its value; values are never shown | for `AGENT`, refuse `ENVIRONMENT` and unset inputs: every input comes from committed files, so signers and the release identity cover them (section 11, U6) | CHAN | 3 | High | N: env-var input in an AGENT prepare refused; P: committed tfvars accepted |
| G-14 | `src/apply/contract.ts` `requirePromotionEvidence` | QA needs a SUCCEEDED DEV apply of the same `releaseIdentity`; PROD a SUCCEEDED QA | also require a VERIFIED observation of the earlier stage; per-environment tfvars change `releaseIdentity` (file hashes are inputs), so the project layout must keep environment values in the contract target or a bound overlay | PROMO | 4 | Medium | P: DEV→QA→PROD with verified observations; N: unverified DEV observation; N: different release identity |
| G-15 | `src/apply/contract.ts` `verifyApplyQualification` | evidence is bound to the DEV target; QA/PROD reuse it (`principalPerEnvironment`) | unchanged in phase 1; record the owner's choice whether QA/PROD need their own qualification | PROMO | 4 | Medium | existing tests; new N if the owner requires per-environment evidence |
| G-16 | `src/apply/readiness.ts` | financial controls `UNVERIFIED`, advisory | budget read by DISCOVERY per provider; READY gate for AGENT | SPEND | 4 | Medium | P: budget at ceiling; N: none or higher; U: read denied counts as missing |
| G-17 | spend bound at seal (`src/apply/seal.ts` or a new `src/apply/spend.ts`) | none | upper-bound computation from the contract's unit costs | SPEND | 2 | Medium | P: under ceiling; N: above, unknown type |
| G-18 | emptiness check (`src/apply/observe.ts`, `src/observe/*`) | observation runs after an apply | a pre-seal and pre-apply sweep (6.4) | DRIFT | 4 | Medium | P: empty target; N: tagged or colliding resource; U: denied read fails closed |
| G-19 | `src/apply/evidence.ts`, `src/apply/live-record.ts` | evidence names approvers and `invocation` | add channel, agent id, apply-service host and account, drift result, spend bound | INT | 4 | Medium | P: evidence validates; N: AGENT evidence without agent id refused |
| G-20 | `src/apply/cleanup-proposal.ts`, `src/observe/run-created-policies.ts`, `src/observe/aws-leaf-types.ts` | identities and groups protected; leaf allowlist small | only after Q8: run-created identity and group proposals; leaf allowlist grows by review; retention classes | CLEAN | 5 | High | P: run-created role proposed; N: engine identity, backend, pre-existing; I: partial cleanup reports pending |
| G-21 | `src/apply/lifecycle-report.ts`, `src/apply/leftovers.ts` | canary-sized runs | full-LZ counts by class and owner; retention states | CLEAN | 5 | Low | P and N on report validation |
| G-22 | `config/production-deployment-contract.yaml`, `src/qualification/production-contract.ts`, `test/production-contract.test.ts` | `initiatedBy: HUMAN_OPERATOR`; a test asserts `AGENT` is refused | add `AGENT_AFTER_HUMAN_SIGNATURE` as an allowed value only together with `AGENT_APPLY`; update that test deliberately, not by relaxing it | INT | 5 | High | N: `AGENT` alone still refused; P: the new value with its binding |
| G-23 | `src/qualification/release-admission.ts`, `config/release/scope.json`, `config/release/status.json`, `docs/release-status.md` | `ACT_RELEASE_PATHS` gates "Owner-supervised DEV apply"; pillar gates moved to v1.1 | new full-LZ gates per path and environment, AGENT evidence admission; regenerate docs with `npm run docs:release` | REL | 6 | Medium | P: admission with AGENT evidence; N: AGENT evidence under a contract without AGENT_APPLY |
| G-24 | `test/apply-boundary.test.ts` | agent-facing roots never reach `src/apply` | keep, and add: the apply service is the only module importing the driver besides the CLI; agent modules reach the apply service only by its queue schema | CHAN | 3 | High | N: an import from `src/agent` or `src/tools` to the apply service or driver fails the test |
| G-25 | `src/agent/act.ts` | `CHANGE` intent returns `ACT_DISABLED` | an `AGENT` request client that writes to the queue, still `ACT_DISABLED` when the apply service reports so | AGENT | 4 | Medium | P: queue write; N: no apply service; U: ACT_DISABLED surfaced |
| G-26 | `src/cli/ui-channel.ts`, `src/operator-ui/app/pilot/*` | wizard for CLI-equivalent steps | `request` and `approve` of AGENT artifacts in the wizard, with the session token; no agent path through the console | UI | 5 | Medium | P: wizard signs; N: wizard cannot apply an AGENT artifact (`CHANNEL_MISMATCH`) |
| G-27 | `src/evidence-runner/act.ts`, `docs/evidence-runner.md` | guided human stages | an `act-lz:<path>` stage that observes apply-service runs; it still never starts one | REL | 6 | Low | P: stage reads evidence; N: never starts an apply |
| G-28 | `scripts/release-stage.sh`, `src/cli/release-package.ts`, `.dockerignore` | the field package carries no contract | unchanged; decide whether the apply service ships in the field package (Q1) | REL | 6 | Medium | existing `test/release-package-exclusions.test.ts`; new N if the apply service is excluded |
| G-29 | `docs/act-pilot-apply.md`, `docs/act-dev-enablement.md`, `docs/act-pilot-walkthrough.md`, `docs/observe-and-cleanup.md` | pilot operations | the AGENT journey and full-LZ operations; edited after open PR #368 (FIX-2) merges, since it touches the first two | DOC | 6 | Low | doc review |
| G-30 | `src/build/*`, `src/design/*`, `src/iac/*` | build is slice-based and synthetic (for example `azure-greenfield-terraform-audit-workspace-v1`, one resource); no generator produces a full applyable LZ project | a full-LZ generator per path that writes a committed project the seal accepts (unit tags, provider config, no refused constructs), or the owner supplies a reviewed LZ project (Q12) | GEN | 2 | High | P: generated project seals within scope (SYNTHETIC); N: generated refused construct is caught by the seal, not trusted |
| G-31 | `bootstrap/aws`, `bootstrap/azure`, `bootstrap/gcp` | APPLY roles sized for the canary types | APPLY permissions for the LZ scope types; owner runs the bootstrap | OWNER + BOOT | 5 | High | bootstrap plan review; N: role without org-level permissions |
| G-32 | `src/cli/apply-service.ts` (new) | nothing checks who can write the code, build or tools that run an apply | at start and per request: the checkout, `dist/`, `node_modules`, `alz`, `PATH` and environment, the approved tool directories, the Terraform plugin cache and provider mirrors, and the cloud CLIs are owned by the apply service's account, not writable by the agent's, and built from the proved commit (5.1, item 5) | CHAN | 3 | High | P: clean install accepted; N: each writable item is `AGENT_BOUNDARY_UNSAFE`; U: a build from an unproved commit refused |
| G-33 | `src/cli/apply.ts` (`request`, `approve`) | the signer CLI runs from whatever checkout the person uses | for an `AGENT` artifact, refuse to sign from a build that fails 5.1, item 5 (`SIGNER_TOOL_UNSAFE`), and document signer-machine setup (Q3) | CHAN | 3 | High | P: signing from a protected build; N: agent-writable build refused before the key is read |
| G-34 | `src/cli/apply-service.ts`, `src/apply/contract.ts` | the contract is accepted when committed locally (`docs/act-pilot-plan.md`, item 9) | 5.1, item 4: fetch the protected branch, verify the owner signature against a service-owned allowed-signers file and/or confirm enforced owner review, else `CONTRACT_NOT_REVIEWED` | CHAN | 3 | High | P: owner-signed contract accepted; N: agent-merged unsigned commit, local-only commit; U: signature by a key not in allowed signers |
| G-35 | repository settings (owner), `.github/CODEOWNERS` | `CODEOWNERS` routes review to the owner (`* @realjkg`), but no setting is required by any PLAN | branch protection requiring the owner's code-owner review on the contract, `src/apply/**`, `src/cli/apply*.ts`, the apply service and the launcher, if Q4 chooses (b) | OWNER | 1 | High | a settings read by the apply service (G-34); N: protection absent refuses `AGENT` |
| G-36 | `src/cli/apply-service.ts` | requests could name any agent | derive the agent principal from queue peer credentials or per-agent queue ownership (5.1, item 7) | CHAN | 3 | Medium | P: listed principal admitted; N: unlisted user id; U: a request carrying an agent field refused (`AGENT_REQUEST_INVALID`) |
| G-37 | `src/evidence/vault.ts`, `src/apply/live-record.ts`, `src/apply/recovery-record.ts`, `src/qualification/release-admission.ts` | the evidence key is read from `AGENTIC_EVIDENCE_KEY` or a file under the home directory of whoever runs the command | the apply service's account holds its own evidence key; `record-live`, `record-recovery` and admission run by a person under that account against its directory | REL | 5 | Medium | P: record-live on service evidence; N: agent account cannot read the key; I: recovery record after a service crash |
| G-38 | `src/apply/contract.ts` `requirePromotionEvidence` | reads one evidence directory | phase 1: an `AGENT` promotion reads only the apply service's directory; a mixed-channel chain is refused with a message that names the channel | PROMO | 4 | Medium | N: CLI DEV then AGENT QA refused; P: AGENT DEV, QA, PROD |
| G-39 | `src/apply/contract.ts` `isKillSwitchActive`, `src/cli/apply.ts` | one switch per checkout; nothing creates it | the apply service reads its own switch and, when named at start, the operator checkout's; `STOP` request; `./alz apply stop` for a person | CHAN | 3 | Medium | P: STOP stops a running engine; N: removal by the agent impossible (ownership); I: switch created mid-apply |
| G-40 | `.github/agents/qa.agent.md` line 40 | "ACT = DISABLED except for the separately governed human-authorized pilot" | point to the approved ACT PLANs and the agent channel's preconditions | DOC | 6 | Low | doc review |
| G-41 | `docs/act-dev-enablement.md` line 5, `docs/act-dev-paths.md` line 3, `docs/observe-and-cleanup.md` line 3 | "no agent ... initiates an apply"; "agents never initiate an observe, a proposal, an approval or a cleanup" | align with the amendment once the channel exists; `docs/act-dev-enablement.md` waits for #368 | DOC | 6 | Low | doc review |
| G-42 | `src/operator-ui/app/pilot/pilot-copy.ts` | plain-language copy for today's refusal codes | copy for every new code (`AGENT_*`, `CONTRACT_NOT_REVIEWED`, `SIGNER_TOOL_UNSAFE`, `DRIFT_DETECTED`, `TARGET_NOT_EMPTY`, `RESOURCE_NOT_IN_SCOPE`, `REFUSED_CLASS`, `SPEND_*`) | UI | 5 | Low | P: each code has copy (existing copy-coverage test pattern) |

**Headline:** 42 gaps: 19 High, 16 Medium, 7 Low. G-01 is this PR.

## 11. Open questions only the owner can answer

- **Q1.** Is the `AGENT` channel for the internal reference build (customer zero) only, as the pilot is, or a product feature that ships in the field package?
- **Q2.** "Full landing zone" per environment (one account, subscription or project, as PLAN-2 proposes) or organization-wide (management account, OUs, SCPs, management groups, Control Tower)? The latter needs organization-level authority and a separate PLAN.
- **Q3.** Key custody: where do signer keys live so that the agent's account cannot read them (a separate signing machine, a hardware key, a cloud KMS signing key with a human-only policy)? Custody includes the signing tool and its display: where does the signer's CLI run so that the agent's account cannot change what it shows or which hash it signs (5.1, item 6)?
- **Q4.** A precondition, not an option: which proof of owner review the apply service requires for the contract and for the code it and the signers run: (a) an owner-signed commit, (b) enforced owner review in branch protection on those paths, or both (5.1, item 4). Reachability from `main` alone is not proof, because agents may merge reviewed heads under the `steward` skill.
- **Q5.** Is an approval of an `AGENT` artifact enough to release it to the agent, or does the owner want a separate signed "execute" statement?
- **Q6.** May the agent later start a signed cleanup through the apply service? PLAN-2 phase 1 says no.
- **Q7.** The spend model: owner-stated unit-cost ceilings (proposed) or a price source; and whether the budget gate also applies to `CLI` and `UI`.
- **Q8.** May a cleanup propose run-created identity objects (except the engine identities) and run-created resource groups? Without it a full-LZ cleanup never reports `COMPLETE`. A yes needs a further reviewed `AGENTS.md` amendment, because the amendment in this PR makes the protected classes mandatory in every channel.
- **Q9.** Which paths go three-stage for the full LZ: AWS Terraform, Azure Terraform and AWS CDK only (proposed), or also Azure Bicep and GCP Terraform?
- **Q10.** Day-2 changes (updates and replaces of an applied LZ): confirm they are out of PLAN-2 and need their own PLAN.
- **Q11.** Promotion: is a VERIFIED observation of the earlier stage required (proposed), and is there a minimum soak time before QA or PROD?
- **Q12.** The source of the LZ IaC: a product generator (large new lane, G-30) or an owner-reviewed project per path?
- **Q13.** Confirm the controls PLAN-2 adds beyond the decision, so nothing is narrower or wider without a decision: the contract's `agents` allowlist; `TARGET_NOT_EMPTY`; the `SPEND_CONTROL_MISSING` budget gate for `AGENT`; the code, tool and signer integrity preconditions (5.1, items 4 to 6); agents may create a kill switch (`STOP`) but never remove one; no mixed-channel promotion chains in phase 1.

## 12. Findings: unsafe or contradictory points in the decision

- **U1 (unsafe without 5.1).** "The agent runs the apply itself" on the operator's machine under the same account defeats every kept control: it can read 0600 key files, delete the ledger and nonces, remove the kill switch, commit a contract locally, or use the APPLY credentials without the driver. PLAN-2 therefore makes the separate apply-service account and off-host keys preconditions, not options.
- **U2.** `HUMAN_TERMINAL_REQUIRED` (a TTY check) does not distinguish a person from an agent with a pseudo-terminal. Today's rule against agent-initiated applies rests on policy; the signatures and key custody are the real controls, which is why U1 matters.
- **U3 (contradictory wording).** "Relax ALL ACT rules" and the list of five kept controls leave other controls unnamed (separate identities, locking, qualification, approval expiry, product-commit binding, typed phrases at human steps, protected cleanup classes). The kept controls depend on them, so PLAN-2 keeps them; the owner should confirm none is meant to go.
- **U4 (contradiction).** A full LZ conflicts with E1's exact canary counts (resolved by `scope`) and with the protected cleanup classes (a full-LZ cleanup cannot reach `COMPLETE`, Q8).
- **U5.** "Discover, plan, build" is not yet real for a full LZ: discovery is partial and the build is synthetic and single-resource (G-30). A greenfield plan on incomplete discovery can collide and partially apply; the emptiness and drift checks reduce this, they do not remove it.
- **U6 (unsafe today for AGENT).** An `ENVIRONMENT` input's value is bound in the plan but not in the release identity and is never shown to signers, so an agent could choose a different value in PROD than in DEV while promotion still matches. G-13 refuses environment inputs in the `AGENT` channel.
- **U7 (unsafe without 5.1, items 4 to 6).** Owning the evidence, ledger, nonces and kill switch is not enough if the agent's account can write the code that enforces them: the apply service's checkout, `dist/`, `node_modules`, the `alz` launcher, its `PATH` or environment, the engine binaries or the provider plugin cache (plugins run under PLAN and APPLY), or the signer's CLI, which could show one bundle and sign another hash with a non-exportable key. And because agents may merge reviewed heads to `main` under the `steward` skill, reachability from the protected branch does not prove owner review. PLAN-2 therefore requires proved owner review (Q4) and code and tool integrity for the apply service and the signers.

## 13. Process

PLAN (this PR, owner review) → DO lanes in the order of section 10, each through the normal steward workflow with its own check-in on #39, disjoint paths, and one serialized integrator for the shared files → CONVERGE on SYNTHETIC end-to-end journeys for each path and channel → ACT (merge) per lane. Enabling ACT stays the owner's reviewed contract commit, and every live run, spend and teardown stays separately authorized by the owner.
