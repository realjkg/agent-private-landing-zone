# AI Studio ↔ Sovereign ALZ — early AWS execution

## Decision

Early **real AWS infrastructure execution** is in scope for an explicitly authorized internal DEV pilot. The prior read-only MCP-only architecture is insufficient as the final capability. Do not bypass existing sealed-plan and human authorization boundaries.

## Reuse existing AWS governance, never duplicate it

The accelerator operates **within** the customer's existing AWS Organizations / Control Tower estate. It consumes Control Tower policies, landing-zone metadata, enabled controls, account enrollment, OU structure, SCPs, AWS Config and CloudTrail baselines through authorized AWS APIs and IaC references. Existing governance remains the source of truth.

- Discover and reuse established Control Tower and Organizations controls and policy templates when policy-authority checks show they are fit for the workload.
- Use AWS APIs and provider-supported tooling for controlled, evidence-linked ALZ creation and integration **inside** existing governed accounts.
- Never create a second Control Tower landing zone or second Organizations organization alongside the customer baseline. A new landing-zone/organization CREATE is rejected.
- Changes to existing Control Tower controls, Organizations policy or OU/account structure are **not equivalent** to a parallel deployment. They are classified as `GOVERNANCE_CHANGE_REQUIRES_SEPARATE_AUTHORITY` and require a distinct policy-owner-approved workflow outside the initial application-resource DEV pilot.
- The current check is admission-only. Enforce the same deny/approval rules against engine-native normalized plans, CDK assemblies, change sets and Pulumi preview before a cloud mutation can happen. Indirect templates/modules must not bypass classification.
- Preserve customer account boundaries, SCPs, IAM permissions, shared networking and monitoring; do not silently adopt state or overwrite authoritative infrastructure.

## Console-free builder versus native Control Tower workflows

The builder does not copy Control Tower's console-wizard steps or create a replacement governance plane. Agents gather desired-state intent, inventory actual AWS Organizations, Control Tower landing zones, registered OUs, account enrollment and enabled controls via authorized APIs, then reconcile effective policy before producing IaC.

- When an account already exists and is governed, use it as the workload target; **do not trigger Account Factory**.
- When an account is needed, route an approved account request to the **customer's existing** Account Factory, AFT GitOps workflow, Service Catalog provisioning, or approved auto-enrollment API; do not recreate AFT infrastructure.
- Discover effective preventive policies (SCP/RCP/declarative policy), detective AWS Config rules and proactive CloudFormation hooks; never assume a default control set from template names alone.
- Reuse approved networking, security, logging and identity infrastructure. Generate **application-scoped deltas only** where the declared business intent requires resources.
- Validate IaC engine output against authoritative ownership and effective controls; engine-normalized plans must undergo the same governance classification, not only the agent's declared resourceActions.
- Avoid console clicks and repetitive CLI workflows by using existing APIs, typed tools, CI pipelines, state backends and gated plan-execute-verify orchestration. Async AWS operations must report real statuses, not imply synchronous completion.
- Record why each resource was REUSED, ADDED, INTEGRATED, or BLOCKED, with policy and account evidence.
- New controls, OU changes, policy lifecycle and account vending are separately authorized governance actions. They are not blanket forbidden, and no operator should need to recreate the Control Tower estate to execute them.
- This stage introduces the classifier but **does not yet wire it into every Terraform plan, CloudFormation change set, CDK assembly or Pulumi preview**. That is a mandatory execution gate before live use.

## Conditional Control Tower bootstrap from conversational intent

The user can request an AWS Landing Zone in natural language. The orchestrator first performs trusted discovery in the management account:

- `landingZone=EXISTS`: reuse the existing Control Tower baseline and its APIs; never provision a parallel landing zone.
- `landingZone=ABSENT` with verified management-account identity: produce an **initial Control Tower bootstrap blueprint** with home region, governed regions, shared accounts, OU layout, baseline control expectations, service prerequisites, cost/risk implications, and exact review bundle. `BOOTSTRAP_APPROVAL_REQUIRED` is not equivalent to execution authority.
- `landingZone=UNKNOWN` or unverified management identity: stop before any CREATE and request read-only discovery/identity evidence.
- Distinguish an existing AWS Organization from an absent one; avoid accidentally running Organizations CREATE inside a live organization.

After dedicated governance approval, a future driver may call versioned AWS Control Tower APIs (create landing zone, obtain operation status, read resulting ARN and controls) with appropriate credentials and reconcile asynchronous outcomes. The current pilot driver is scoped to AWS Terraform/CDK DEV application resources and **does not implement this Control Tower API execution yet**. No automatic Control Tower create is authorized by the classifier.

Subsequent template-tested AFT / Account Factory / Service Catalog automation is a separate phase, reusing the resulting organization and accounts instead of running a duplicate bootstrap.

## Executed blueprint inventory and progress states

When the user invokes a blueprint, the console, agent and eventual MCP tools should read a shared **per-resource execution inventory** rather than return a one-time plan. The code contract is `src/integrations/ai-studio/blueprint-inventory.ts`.

Inventory entries have resource ID, provider, kind, requested action, source-of-truth (`EXISTING_AWS`, `BLUEPRINT`, `UNKNOWN`), current state, timestamp, evidence references and optional diagnostic detail. The status vocabulary is:

`REQUESTED → DISCOVERING → DISCOVERED → PLANNED → VALIDATING → AWAITING_APPROVAL → APPROVED → EXECUTING → VERIFYING → SUCCEEDED`

An existing Control Tower may transition from `DISCOVERING → REUSED`; failures may terminate in `BLOCKED` or `FAILED` and later enter recovery. Updates append hash-linked events and retain a count of items in each state. Success/reuse must have evidence references, and approvals/execution require evidence.

**Current implementation boundary:** the new inventory reducer and unit tests are scaffolded, not yet wired to AWS Cloud Control/Control Tower polling, the apply driver's actual execution ledger, durable encrypted storage, Web UI push events or the hosted MCP gateway. Each corresponding adapter must write a verified state transition only upon observing its real outcome; a model's text must never set `SUCCEEDED`.

## Blueprint-first execution, promotion and operations

**Priority:** Finish the complete validated blueprint before any cloud apply. Lifecycle: **Inventory → Plan → Design → Blueprint approval → Execute in DEV / NON-PROD → Verify → Promote with a separate production plan and approval → Execute in PROD → Verify → Operate (Maintain)**.

- Inventory: actual AWS governance/account/resource state, ownership, dependencies, policies and evidence of any unknowns.
- Plan: exact scope and targets, dependency graph, IaC tool/engine choice, costs, controls, network/identity/logging, recovery and state.
- Design: finalized tested resource blueprint and generated IaC, with hashes, scan and policy evidence, and approval.
- Non-production: generate a separate environment-targeted sealed plan from the approved release. Deploy and verify DEV and/or the explicitly designated NON-PROD qualification stage. When a DEV→QA chain is configured, QA follows verified DEV.
- Production: distinct production-target plan and state, identity, independent approvals, same verified logical release identity, and authoritative deployment verification.
- Operate (Maintain): inspect health, incidents, drift, capacity, costs, upgrades and configuration; **Modify is a maintenance sub-workflow**, performed by creating a versioned blueprint revision, computing the delta, validating, approving, staging and promoting it. Never mutate an approved baseline in place.
- The executed blueprint inventory must surface every step and provider status, including BLOCKED/FAILED and evidence. Passing a metadata admission function does not substitute for actual state validation.
- Current implementation: `src/integrations/ai-studio/blueprint-release.ts` is a staged approval/release-admission contract, not a Control Tower provisioning driver. `blueprint-inventory.ts` is a state projection, not yet provider-wired.

**Acceptance gate:** Blueprint COMPLETE + APPROVED before applying, verified nonproduction release and independently approved target-specific plan before production. Each stage remains subject to the signed apply driver; none can be triggered solely by MCP agent request.

## Existing implementation to reuse

- `src/apply/driver.ts`, `src/cli/apply.ts`, and `src/cli/ui-channel.ts`
- Terraform sealed-plan apply and AWS CDK sealed CloudFormation change-set execution
- Pinned contract, environment-bound identities, signed approval, kill switch, encrypted evidence
- See `docs/act-pilot-plan.md`, `docs/act-pilot-apply.md`

## First new code slice

`src/integrations/ai-studio/aws-execution.ts` implements conservative capability negotiation. An eligible Terraform/CDK internal DEV case is **only a routing recommendation to the existing human pilot driver**, not a permit to execute. All existing driver checks remain authoritative. The MCP agent may request and inspect an operation but cannot directly apply via this facade.

It does **not** expose an HTTP listener, implement MCP transport, validate a JWT, deploy AWS resources, qualify an engine, or enable the pinned pilot contract. Each is a separate gate. AI Studio can only connect after an authenticated remote MCP gateway is implemented.

## Engineering sequence

1. Run tests for this change and existing apply contract: `npm run build && npm run test:node`.
2. Verify exact-source CI and CodeQL and reconcile with auth-provider PR #163.
3. Qualify **real Terraform and AWS CLI/CDK binaries** against an isolated owner-supplied AWS DEV account: discovery, preview, identity separation, state/lock, scoped IAM, asset and rollback behavior.
4. Operator enables only the audited and pinned pilot contract after this qualification. Keep the existing human interactive approval requirement.
5. Execute a reversible minimal AWS DEV resource, collect authenticated signatures and encrypted evidence, verify state and resource, then exercise recovery.
6. Complete separate CloudFormation-direct and Pulumi execution engines and their own denial/approval/rollback tests. Do not accidentally treat CDK's CloudFormation change-set apply as a generalized CloudFormation direct driver.
7. Implement MCP Streamable HTTP and OAuth/OIDC resource-server verification; publish read-only and proposal tools first. Add human workflow handoff/status; **never make token possession equivalent to infrastructure approval**.
8. Confirm hosted AI Studio handshake and end-to-end agent → MCP → operator-reviewed pilot → AWS evidence.

## Acceptance

No unrestricted AWS permissions, no customer-resource adoption, no secret serialization, no CI failure, no ungrounded PASS claim. Every ACT requires the sealed artifact, signed approval, exact target, valid contract, qualified engine, distinct identities, working kill switch, and authoritative cloud result. Production authorization remains a separate phase.
