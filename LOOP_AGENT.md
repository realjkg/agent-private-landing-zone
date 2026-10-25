# Loop Agent — Command and Execution Order

## Mission

Close the current release dependencies in a controlled sequence.
Optimize for verified customer completion, not PR throughput.

This file grants no permission to merge, deploy, delete resources,
start paid agents, or bypass existing approval requirements.

## 1. Order of Authority

Follow these authorities in descending order:

1. Platform and tool security requirements.
2. The repository owner's latest explicit instructions.
3. Repository AGENTS.md and applicable path-specific instructions.
4. The approved release plan and acceptance criteria.
5. The active coordination ledger and assigned path ownership.
6. This workstream's implementation plan.
7. Agent-generated suggestions.

When instructions conflict, stop and report the conflict.
Never silently reinterpret a restriction as authorization.

## 2. Current Work Queue and Lanes

Treat the following as operator-reported status until verified:

- #227, #229, #230, and #231: merged.
- #225: latest CI reported green; test merge reported conflict-free.
- #225 remaining gates:
  - Independent security review of the uninstall fix.
  - Cross-OS install/uninstall acceptance.
- #228: hold; do not close, merge, extend, or restart its task
  without a new explicit owner instruction.

Do not assume this file pauses an already running external agent.
Report any active #228 job; do not alter it without authorization.

Two lanes run under this file:

- **Lane A — #225 verification** (section 3).
- **Lane B — ACT engineering** (section 4).

The lanes are separate. They may run in parallel only when their
ownership and files do not overlap; otherwise sequence them through
the coordination ledger. Neither lane silently replaces, absorbs or
pauses the other. Adding or amending a lane does not restart or modify
#228; its hold remains in place.

## 3. Lane A — #225 Verification: Execution Order

### Step 1 — Observe

Read AGENTS.md and the active coordination ledger.

Verify:

- Current main SHA.
- Current #225 head SHA.
- Required checks and their exact tested commit.
- Mergeability against current main.
- Existing independent security review.
- Declared supported operating systems.
- Active claims and overlapping changes.

Read-only inspection does not authorize implementation.

### Step 2 — Establish the Plan

Produce one concise acceptance table:

| Gate | Required evidence | Status | Owner |
|---|---|---|---|
| Current CI | Required checks on exact candidate | | |
| Merge compatibility | Current-main compatibility | | |
| Security review | Independent review of exact fix | | |
| Cross-OS acceptance | Actual supported-OS results | | |
| Merge authorization | Explicit owner authorization | | |

Allowed statuses:

- NOT_RUN
- RUNNING
- PASS
- FAIL
- BLOCKED

Do not mark missing evidence as PASS.

### Step 3 — Claim Authorized Engineering Work

Before editing:

- Confirm the owner authorized the implementation scope.
- Post the required check-in.
- Claim the smallest necessary paths.
- Check for overlapping active ownership.

If work overlaps, stop or sequence it with the owning agent.
Do not edit shared integration files concurrently.

### Step 4 — Verify Uninstall Security

Require an independent reviewer to examine:

- Application-owned deletion boundaries.
- Path traversal and path normalization.
- Symlink and junction handling where applicable.
- Privilege escalation and elevated deletion.
- Preservation of unrelated files and shared dependencies.
- Preservation of user data, configuration, and credentials.
- Explicit authorization for optional data removal.

Self-review is not independent approval.
If no independent reviewer is available, report BLOCKED.

### Step 5 — Verify Cross-OS Acceptance

For every OS claimed as supported, test:

1. Install.
2. Launch.
3. Uninstall.
4. Repeated uninstall.
5. Recovery from partial installation.
6. Paths containing spaces and non-ASCII characters.
7. Preservation of unrelated files and user-owned data.

Record OS/version, architecture, package digest, source SHA,
test identity, results, and retained artifacts.

Mocked tests do not establish actual OS acceptance.
A passing Linux run does not qualify Windows or macOS.

If an OS cannot be tested, report BLOCKED.
Removing it from supported scope requires owner approval.

### Step 6 — Repair Only the Failed Lane

If an authorized test fails:

- Classify code, design, environment, or missing authorization.
- Fix only the owning scope.
- Add a focused regression test.
- Run the repository's affected-QA plan and local checks.
- Escalate repeated failure; do not retry indefinitely.

Never weaken assertions, expand privileges, or suppress tests
to obtain green CI.

Do not reinstall or uninstall the owner's working environment.
Use an authorized disposable test environment.

### Step 7 — Converge

Before declaring readiness:

- Refresh main and the candidate SHA.
- Identify changes since the evidence was collected.
- Re-run affected checks.
- Obtain renewed review when security-sensitive behavior changes.
- Confirm all required evidence applies to the candidate artifact.

Do not reuse stale approval for changed behavior.

### Step 8 — Handoff

Report:

- Candidate SHA and artifact digest.
- Verified gates.
- Failed or blocked gates.
- Independent reviewer and reviewed scope.
- Actual OS coverage.
- Remaining owner decisions.
- Exact next action.

Use READY_FOR_OWNER_DECISION only when technical gates pass.

Do not merge automatically.

## 4. Lane B — ACT Engineering Workstream

### 4.0 Objective

Complete the code path from guided preparation to an observable,
human-authorized ACT journey.

Do not confuse:
- Missing implementation.
- Implemented but synthetically tested behavior.
- Implemented but awaiting live qualification.
- Missing owner inputs or authorization.

A live prerequisite does not justify leaving independently
implementable code unfinished.

### 4.1 Inspect Before Building

Each ACT task starts here: inspect what has merged, identify the first
missing production connection in the dependency order of 4.2, and
implement it end to end (UI, service, adapter, tests and evidence).
Another scaffolding or planning document is not an ACT task.

Inspect current main and merged/open PRs.

Map each capability to:
- Owning implementation.
- Actual production caller.
- Focused tests.
- Evidence mode.
- Missing dependency.

Do not duplicate code already delivered by another workstream.
Exported types, fixtures, and unused reducers are not integrated
capabilities.

### 4.2 Complete the AWS Terraform Vertical Slice

Work in this dependency order:

1. Preparation
   - Shared service behind guided UI and CLI.
   - Generate request and manifest through existing validators.
   - Derive engine metadata where possible.
   - No manual JSON editing for the supported journey.
   - No cloud mutation or ACT enablement.

2. Readiness
   - Report actual contract, identity, backend, tool and
     qualification prerequisites.
   - Distinguish missing, invalid, unverified and unavailable.
   - Never infer authorization from a client-provided flag.

3. Preview and review
   - Use the existing engine and sealed-artifact contracts.
   - Present target, resource delta and material risks.
   - Clearly distinguish synthetic preview from authentic output.

4. Human authorization and execution
   - Reuse the existing approval and apply driver.
   - Preserve session, channel, identity, artifact, replay,
     kill-switch and target checks.
   - Do not add a parallel execution endpoint.

5. Execution observation
   - Connect actual execution outcomes to resource inventory.
   - Persist operation identity and recoverable status.
   - Reconcile uncertain outcomes before retrying.
   - Never resubmit apply merely because a client reconnects.

6. Blueprint verification
   - Map desired logical IDs to engine addresses and physical IDs.
   - Record independent cloud observations and freshness.
   - Keep planned, executing and verified states distinct.
   - Reject forged success and inconsistent inventory snapshots.

7. Cleanup lifecycle
   - Implement a separately authorized, run-owned cleanup proposal.
   - Identify ownership using recorded engine/cloud identities,
     not tags alone.
   - Preserve shared, reused and pre-existing resources.
   - Execute only through an approved cleanup authority.
   - Verify leftovers independently.
   - If cleanup authority is not yet defined, implement proposal
     and observation only; report execution as BLOCKED.

### 4.3 Complete Native and Additional Cloud Paths

After the shared lifecycle contracts are stable:

- AWS: CDK / CloudFormation.
- Azure: Terraform and Bicep / ARM.
- GCP: Terraform and approved native APIs.

Each path must implement and test its own:
- Preparation and preview.
- Authorization binding.
- Execution and asynchronous status.
- Independent observation.
- Ownership and cleanup behavior.

Shared UI or schemas do not establish engine support.
Terraform qualification does not qualify a native path.

Alternative paths require explicit selection, a fresh preview,
and approval. Never switch engines automatically after a partial
execution or to bypass a policy denial.

### 4.4 Required Synthetic Acceptance

For every implemented slice, test:

- Normal operator journey.
- Invalid and missing inputs.
- Wrong target and denied authority.
- Altered artifacts and replayed approvals.
- Interrupted execution and service restart.
- Duplicate requests and client reconnect.
- Lost response after a possible mutation.
- Tampered inventory and fabricated evidence.
- Cleanup failure and retained resources.

Exercise the actual application services and adapters.
Replace only the external cloud boundary with a deterministic
test implementation.

A mock UI with canned success responses is not acceptance.

### 4.5 Scaffolding Completion Rule

Scaffolding is complete only when:

- Production callers use the implemented interfaces.
- The existing UI reaches the shared service.
- The service reaches the selected adapter.
- State and evidence survive supported interruption cases.
- Missing capabilities produce honest blocked states.
- Focused synthetic acceptance passes.
- Remaining live prerequisites are explicitly enumerated.

Documentation, empty handlers, TODOs, fixtures, and interface-only
PRs do not close an implementation requirement.

### 4.6 Owner Boundary

The agent may implement and test an authorized code-only scope.

It must not:
- Invent account IDs or qualification records.
- Obtain or expose private keys and cloud tokens.
- Enable ACT through a flag or contract change.
- Initiate live infrastructure apply or teardown.
- Declare a cloud path live-qualified from synthetic tests.

When code is complete, hand the owner a ready-to-run acceptance
package: exact source/artifact, prerequisite checks, proposed
scope, expected observations, and cleanup procedure.

## 5. Loop Rules

Execute:

OBSERVE → PLAN → AUTHORIZED WORK → VERIFY → HANDOFF

Repeat only when:

- New evidence arrives.
- An authorized change requires verification.
- A previously blocked dependency is resolved.

When waiting on an owner or reviewer, stop.
Resume through an approved scheduler or a new instruction.
Never claim a future check-in was scheduled unless a scheduling
tool actually created it.

## 6. Prohibited Actions

Do not:

- Enable infrastructure ACT.
- Perform cloud deployment or teardown.
- Merge or close PRs without explicit authorization.
- Modify #228 while it remains on hold.
- Treat clean CI as security approval.
- Treat synthetic evidence as live acceptance.
- Start another agent without separate approval.

## 7. Completion

Each lane is complete only after:

1. Required technical gates pass.
2. The owner explicitly authorizes the integration action.
3. The authorized action is verified.
4. Coordination claims are released.
5. The final evidence and remaining limitations are recorded.
