# Operator guide

The Agent Private Landing Zone has an operator-facing command surface so normal use does not require remembering npm scripts.

## First-time source checkout

From the repository root:

```bash
./alz bootstrap
```

This installs the locked runtime dependencies. After bootstrap, use `./alz` for day-to-day operation.

## Common commands

```bash
./alz help
./alz doctor
./alz health [--serve]
./alz demo
./alz design aws terraform brownfield
./alz design aws cdk brownfield
./alz design aws ansible brownfield
./alz design azure bicep brownfield
./alz inspect aws
./alz inspect azure
./alz session aws terraform
./alz session azure pulumi
./alz debug aws terraform brownfield --fixture --request "Review this environment for the strongest operational risk."
./alz debug aws terraform brownfield --request "Review this environment for the strongest operational risk."
./alz target init <target-id> <owner> <aws|azure> <scope-id> <startup|enterprise> <development|production> <non-critical|business|critical>
./alz target check <intent-file>
./alz target explain <intent-file>
./alz recovery status [target-file]
./alz recovery test [target-file]
./alz plugins
./alz prompts
./alz models list
./alz models verify
./alz sbom
./alz scan
./alz verify
```

### demo

Runs a deterministic, non-mutating scenario through the governed kernel:

```bash
./alz demo aws terraform brownfield
./alz demo azure pulumi greenfield
```

The demo exercises discovery, posture assessment, brownfield delta decisions, an evidence-linked DesignSpec, plug-in selection and the Build boundary. It does not modify infrastructure.

### design

Runs the same governed deterministic path with Design as the explicit operator goal:

```bash
./alz design aws terraform brownfield
./alz design aws pulumi brownfield
./alz design aws cdk brownfield
./alz design aws ansible brownfield
./alz design azure bicep brownfield
```

All eight build adapters are implemented. CDK reuses the CloudFormation Change Set path. Ansible uses check/diff with explicit managed-host access. Crossplane uses local render and keeps changes UNKNOWN until controller reconciliation is observed.

### inspect

Runs live read-only provider discovery:

```bash
./alz inspect aws
./alz inspect azure
```

### session

Starts the secured conversational operator session with local model reasoning:

```bash
./alz session aws terraform
./alz session azure pulumi
```

### debug

Runs the governed kernel with a developer-focused diagnostic view:

```bash
./alz debug aws terraform brownfield --fixture --request "Review this environment for the strongest operational risk."
./alz debug aws terraform brownfield --request "Review this environment for the strongest operational risk."
```

Use `--fixture` when debugging TypeScript, orchestration, policy, build-gate, or trace behavior without invoking local models. Omit it when diagnosing the configured private Qwen/Mistral stack.

DEBUG changes visibility only. It uses the same deterministic operator policy and kernel boundary as normal operation, keeps ACT disabled, never grants cloud or mutation authority, and never enables arbitrary shell execution.

The console and JSONL trace expose one correlation ID across the agent, policy, model, tool/adapter, checkpoint and recovery diagnostic context; deterministic phase timing; model role/tag/digest metadata; structured-output validity; validator participation; evidence/UNKNOWN state; build/action boundaries; and sanitized failure classification. Tool and adapter diagnostics record command class, decision/result status, duration, exit status, byte counts and short redacted stdout/stderr excerpts rather than raw command transcripts.

DEBUG also runs a bounded SQLite checkpoint probe under the same run/thread ID. It creates a local checkpoint, reopens the LangGraph session and verifies that history continues after the graph is recreated. The result and local checkpoint path are included in the report so checkpoint/restart defects are distinguishable from model or TypeScript failures.

A `REVIEW_REQUIRED` grounding result is a diagnostic signal, not a claim that a model hallucinated. Investigate missing evidence references, explicit assumptions, unresolved discovery conflicts, UNKNOWN environment state, schema/model failures, and independent-validator disagreement before attributing the result to model behavior. The report explicitly distinguishes `KNOWN`, `UNKNOWN`, `INFERRED_ADVISORY` and `POLICY_BLOCKED` states.

Structured-output failures report a zero-retry, `FAIL_CLOSED` fallback in the current production contract. DEBUG does not silently retry a malformed model result or widen a timeout to obtain green output.

The same redaction/minimization helper is used by DEBUG and production structured observability. Secret-like fields, inline secret assignments, bearer values and private-key blocks are redacted. The trace fingerprints the operator request instead of storing it and does not persist full prompts, full model responses, credentials, secret values, or chain-of-thought.

Traces are written locally under `.runs/debug/<run-id>.jsonl` with restrictive file permissions. Checkpoint probes are written under `.runs/debug/checkpoints/`; both are bounded to a seven-day/50-file local retention window.

In a source checkout, `./alz debug` intentionally prefers the TypeScript source path and enables source-map support. Only this opt-in local DEBUG path may print a short sanitized stack. Packaged/default operation remains on compiled code and does not enable developer stack output by default.

### target

Creates, validates, or explains a small customer recovery intent. Basic initialization uses seven meaningful answers; compiled hashes, leases, policy metadata, and evidence lineage remain internal.

```bash
./alz target init platform-prod platform-operations aws 123456789012 startup production critical
./alz target check config/recovery-intents/platform-prod.json
./alz target explain config/recovery-intents/platform-prod.json
```

### recovery

Inspects configured recovery targets or performs the non-mutating recovery-test readiness preflight.

```bash
./alz recovery status config/recovery-targets.json
./alz recovery test config/recovery-targets.json
```

A blocked recovery test returns a failing process status for automation. It does not restore or mutate infrastructure.

### prompts

Shows the built-in prompt guide for unfamiliar operators:

```bash
./alz prompts
```

The same guide is available conversationally by typing `help` or `prompt guide`.

Requests are checked before local-model routing. The operator is redirected when a prompt asks to reveal credentials/secrets, move private evidence outside the trust boundary, bypass approvals/policy/audit/security controls, invoke arbitrary shell execution, or perform clearly unrelated work outside the Landing Zone scope.

A denied request includes a plain-language reason and a safe alternative. For example, instead of asking for a secret value, ask for its owner, scope, age, reference, or rotation posture without revealing the value. Instead of asking to bypass an approval, ask which control is blocking progress and what evidence or authorized change would satisfy it.

After a denial, `why was that blocked?` explains the recorded boundary, while `prompt guide` shows working examples.

### models

Lists or qualifies the local private models:

```bash
./alz models list
./alz models verify
./alz models verify --all
```

The required set is Qwen3 1.7B, Qwen3 4B, and Mistral Nemo. Qwen3 8B is the optional larger model. Qualification checks structured output, repeatability, evidence isolation, indirect prompt injection inside untrusted evidence, and secret-canary leakage. Direct override, role hijack, hidden-prompt disclosure, and tool-coercion attempts are rejected by the deterministic operator boundary before model invocation.

### doctor

Checks the local security preflight, plug-in compatibility catalog and toolbox availability.

### health

One-shot health and readiness report, optionally serving the loopback endpoints:

```bash
./alz health
./alz health --serve
```

Run it when something feels off: the report shows the health line (operating mode `PREVIEW_OPERATE`, ACT `DISABLED`), a `readiness: READY` / `NOT READY` verdict with one line per check — including the production-contract observability verdict — and the effective configuration echo (structured events, health server, monitoring export). Exit status is `0` when ready, `1` when not, so it works in scripts.

What to check first, in order:

- **A command misbehaved** — the stdout JSON event lines tell you which signals fired (`policy-denials`, `adapter-failures`, `model-restarts`, ...), with redacted detail. `[warn] ...` lines on stderr are diagnostics (config refusals, disabled export, failed sinks), not event output.
- **The runtime feels slow or wedged** — `./alz health` for readiness, or probe `/healthz` (liveness) and `/readyz` (readiness with the contract verdict) on a serving runtime (`./alz session` or `./alz operator-web` print the loopback address at startup).
- **You want totals over time** — `/metrics` exposes Prometheus-format counters (`alz_operational_event_total`) aggregated by signal/status/component; point any local Prometheus-compatible scraper at a serving runtime.
- **You suspect secrets leaked into logs** — events are redacted at construction (bearer tokens, private keys, secret-like keys); the alert-rule and event schemas live as versioned config checked in CI.

The full surface — event schema and signal catalog, environment variables, endpoint contracts, alert-rule semantics, and how to point an OTLP collector or Splunk HEC at the export doors — is documented in [docs/observability.md](observability.md).

### verify

Runs the operator regression suite without requiring the operator to know individual developer commands. It covers:

- TypeScript checks
- all unit/regression tests
- security preflight
- plug-in compatibility
- toolbox availability
- AWS brownfield discovery fixture
- Azure brownfield discovery fixture
- Azure greenfield discovery fixture
- unknown-environment fail-closed behavior
- dependency security audit
- private-model qualification harness tests

### sbom

Generates a CycloneDX SBOM from the locked dependency graph and writes it under `.runs/sbom/`.

### scan

Runs the package dependency audit. If Trivy is installed locally it also scans the accelerator filesystem for HIGH/CRITICAL vulnerabilities and infrastructure misconfigurations. The full Trivy/SBOM supply-chain workflow is an explicit release gate rather than an automatic per-PR or per-merge job.

## Agent-assisted build sequence

The simulated landing-zone build program has been qualified through chat and direct kernel invocation across all eight registered adapters.

The underlying engineering sequence is deterministic: **PLAN → parallel non-overlapping DO → CONVERGE/VERIFY → single ACT boundary**. Infrastructure ACT remains disabled.

A normal guided sequence is:

1. **Intent** — describe the platform outcome in natural language.
2. **Discover** — inspect or load the simulated estate and identify known vs UNKNOWN evidence.
3. **Assess** — review security, resiliency, ownership, and operational constraints.
4. **Design** — explain the delta using REUSE / INTEGRATE / CONFIGURE / ADD / NO_TOUCH / BLOCKED decisions.
5. **Adapter selection** — choose or compare the preview adapter for the scenario.
6. **Build preview** — generate the governed, non-mutating adapter preview.
7. **Evidence review** — review the normalized ChangeSet, hashes, assumptions, grants, and safety blocks.
8. **Next step** — explain what would be required to proceed while keeping ACT disabled.

The operator can ask follow-ups such as `status`, `what should we do next?`, `why was that blocked?`, `compare IaC`, or request a different supported preview engine.

This is **agent-assisted**, not autonomous deployment. The conversational agent guides the build process, but deterministic policy and capability gates remain authoritative.

For simulated adapter qualification, compare the direct adapter result with the chat-guided result. They should converge on materially consistent design intent and normalized ChangeSet semantics.

## Scenario coverage

| Scenario | Discover | Assess | Delta | Design | Build | ACT |
| --- | --- | --- | --- | --- | --- | --- |
| AWS brownfield | live read-only + fixture | supported | supported | DesignSpec | Terraform, Pulumi, OpenTofu, CloudFormation UPDATE, CDK, Ansible, Crossplane | disabled |
| AWS greenfield | fixture | supported | supported | DesignSpec | Terraform, Pulumi, OpenTofu, CDK synthesis; CloudFormation CREATE remains Design-only | disabled |
| Azure brownfield | live read-only + fixture | supported | supported | DesignSpec | Terraform, Pulumi, OpenTofu, Bicep, Ansible, Crossplane | disabled |
| Azure greenfield | fixture | supported | supported | DesignSpec | Terraform, Pulumi, OpenTofu, Bicep, Crossplane | disabled |
| Private/edge attached assets | evidence ingestion | supported | supported | DesignSpec | Ansible and Crossplane preview paths | disabled |
| Sovereign/disconnected | evidence ingestion | supported | supported | DesignSpec | local/offline preview where adapter dependencies are present | disabled |

Preview support does not mean deployment authority. Phase E confirmed direct and LangGraph paths materially converge across the eight adapter scenarios while ACT remains disabled.

## Maintenance

Routine pull requests use the fast deterministic gate:

1. locked dependency install
2. TypeScript type-check
3. unit/integration tests
4. plug-in catalog/runtime consistency

Heavyweight qualification is reserved for actual release needs.

The private-model workflow and the full supply-chain workflow are manual release gates. They are not automatically started by every pull request or merge to `main`.

Use existing qualification evidence when the runtime under release has not changed. Run the required Qwen/Mistral model gate, optional Qwen3 8B gate, SBOM/Trivy scan, or broader release scenarios only when the release phase materially requires fresh evidence.

Dependabot separately opens update PRs for npm dependencies and GitHub Actions. The plug-in catalog tracks tested versions and review freshness for infrastructure engines.


## Operating Economics (D8)

Run a read-only report from an evidence-backed USD-cent allocation file:

`./alz economics report config/economics.example.json`

For machine-readable output, append `--json`. The example is **synthetic qualification data**, not a real AWS, Azure or private cloud invoice. Cost collectors must normalize source invoices or approved allocation schedules into the v1 input contract (`src/economics/report.ts`). No live provider pricing, arbitrary rate card or AI benefit is assumed.

Each input records provider (private substrate, AWS or Azure), Platform/Application LZ scope, platform/governance/observability/resilience category, base or incremental AI Operations cost, observed/estimated status, and an evidence reference. Monthly totals show the AI Operations premium and share **within total expense**; this is not an additional surcharge to add again. Closed-month forecasting requires two consecutive observed-only history months and reports a trailing average, not a machine-learning estimate. Open or estimated months cannot generate anomaly comparisons. A budget warning can still fire against observed spend for an open month.

Budget, forecast and anomaly events enter the existing redacted operational-event contract. Optional local OTEL and Splunk HEC can export them through sovereign monitoring validation; the bounded Prometheus renderer emits no identifying attributes. External telemetry and generic cloud ACT remain disallowed by the selected runtime profile. No economic signal may execute provisioning, deprovisioning, scaling, scheduling, cost changes or generic shell commands. Actionable recommendations require separate future policy-authorized work.


## Private substrate EnvironmentProviders

The initial read-only production contracts in `src/environment/` support Kubernetes, OpenShift, VMware Cloud Foundation (SDDC Manager), vCenter and sovereign edge. They supply identity, capabilities, discovery, inventory, health, topology and evidence summaries without exposing mutation. Cloud AWS/Azure discovery remains an optional hybrid binding, not a private substrate prerequisite.

API providers use published GET inventory paths through an injected transport, with a separate allowlisted HTTPS fetch transport for customer integrations. Credentials are opaque `secret://`, `vault://` or `keyring://` references resolved only inside transport. Neither response summaries nor observation hashes expose tokens. The runtime-profile binding denies external discovery in strict private-sovereign profiles; disconnected operation requires a declared local endpoint.

OpenShift ClusterVersion and VMware SDDC Manager APIs are separate from Kubernetes and vCenter. Kubernetes pagination and bounded response sizes are enforced; inability to observe a source makes inventory incomplete, never a healthy empty inventory. vCenter inventory and VCF domain visibility are not treated as proof of service health. Offline edge inventory must be signed by Ed25519 against an operator-pinned public key; its health is an attested observation, not a live probe.

These contracts run against synthetic HTTP responses in CI. Customer endpoint reachability, RBAC scope, CA trust, infrastructure versions, API pagination at estate scale, and source integrity require qualification in that customer's sandbox before production promotion. Only GET is supported; there is no playbook execution or generic infrastructure ACT.


## Sovereign local change ledger

The implemented metadata ledger in `src/change-ledger/local.ts` stores immutable revisions in a customer-controlled directory (`sovereign-changes.ndjson`). Initial records are written *before* any prospective operational execution. Each entry binds the human requestor, optional distinct agent actor, target and resource scope, approved playbook hash, preconditions, blast radius, approval state, policy/lease references, execution/verification state, evidence references, and prior hash.

A verified append obtains a local exclusive writer lock, refuses invalid existing hash chains, then fsyncs an append-only entry. The filesystem requires customer encryption and restricted OS access; ordinary hash chaining alone cannot stop an adversary who controls the host and rewrites the entire ledger. Export can be signed with an operator-controlled Ed25519 key, and the export verifier checks the signature, chain, head and evidence manifest independently. Private keys remain external to model prompts, manifests and repo code.

`DISCONNECTED` mode requires no Jira, ServiceNow or CMDB. `CONNECTED` records must carry an external ITSM identity. `RECONCILED` appends a new version containing external references while preserving the original local canonical ID and all prior signed history. The referenced encrypted evidence bytes are maintained by the existing customer evidence vault; the ledger/export retains their immutable reference manifest rather than duplicating sensitive payloads.

Jira, ServiceNow, CMDB, GitHub, GitLab, Jenkins and CircleCI are optional typed contracts only until a deployment explicitly binds an adapter. A ticket, an approval flag, or a CMDB identity is never a deterministic policy grant. The ledger cannot authorize ACT; bounded operational execution requires a later signed playbook, human-sponsored capability lease, policy decision, and pre/post verification. No generic infrastructure ACT is exposed.


## Human-sponsored delegated agent authority

`src/delegation/identity.ts` implements separate human and agent actors with verified MFA assurance, provider-supplied RBAC entitlements, deterministic policy checks and narrow task-specific capability leases. The issuer independently verifies the human's session and MFA (AAL2 for read-only, AAL3 for bounded remediation), matching exact target and action through authoritative RBAC and the existing compromise-state policy. Provider/policy unavailability denies. The same checks run immediately before each use.

Leases are in-process and expire within ten minutes, allow at most five executions, bind the exact task/environment/resource/agent/harness/operation, and can be revoked. Restart or process loss invalidates unpersisted leases; no lease is copied to another harness, agent, or A2A destination. Production integration must supply an independently authenticated human identity verifier and RBAC/policy services; mocked verifiers in CI do **not** constitute customer identity-provider qualification.

This contract provides no credentials or MFA challenge bytes to LLMs. Read-only and named managed operations are typed; Terraform apply, Pulumi up, CDK deploy, arbitrary shell and global ACT are not supported. Issuing a lease does not independently execute or authorize any action without the future bounded operations gate.


## Bounded managed operations

`src/managed-operations/operations.ts` implements typed playbook integrity, read-only diagnosis/validation/preview/recovery tests and individually gated named operational ACT through an injected `ManagedOperationsProvider`. Milestone 1 action types are restricted to `RESTART_SERVICE`, `RECONCILE_SERVICE` and `RESTORE_SERVICE`; maximum blast radius is one named target for this initial qualification contract. The executor has no generic command, Terraform apply, Pulumi up, CDK deploy, or global ACT route.

Operating a playbook requires an **existing** canonical local change record before issuance of the sponsored agent lease. The record must reference the exact approved playbook hash, target, initiator, approval reference and state, preconditions and permitted blast radius. The executor then evaluates preconditions, issues and consumes a fresh human-sponsored capability lease, rechecks preconditions, appends a hash-linked STARTED record and invokes the typed adapter. It verifies postcondition outcomes; failed verification invokes recovery when required, and appends a hash-linked outcome with evidence references.

All mutation-capable providers must be installed and qualified at the customer site, using least-privilege credentials and abort-aware actions. CI injects synthetic adapters; no live operating action or production mutation is claimed. Timeouts and cancellation are requirements of each provider implementation; network disconnection/crash can leave STARTED records needing reconciliation. No automatic replay occurs.


## A2A sovereignty confinement

`src/a2a/confinement.ts` provides a strict signed Ed25519 A2A task/evidence envelope. Only a schema-versioned task ID, read-only intent, opaque evidence references, source/destination environment and harness IDs, sovereignty domains, short TTL, delegation depth and parent envelope reference can be transmitted. Unknown fields (including MFA, credential, lease, ACT and approval state) fail validation. Maximum TTL is five minutes, hop depth is bounded, source signatures are verified against destination-pinned trust keys and the destination must atomically claim envelope IDs in a replay store.

The destination checks the destination identity, its own runtime sovereignty profile, signature, TTL/hops, and **its own deterministic authorization policy** before accepting task references as untrusted inputs. Remote approval, leases or ACT cannot be inherited. The private-sovereign disconnected profile denies A2A completely; connected/multisite private profiles deny cross-sovereignty-domain exchange. The signed contract contains no transport implementation or credential propagation. A production deployment must supply trusted keys, durable replay storage and a locally authoritative destination policy; tests qualify synthetic stores and policies only.

## Credentials for live discovery and previews

Tools the governed runner starts (AWS and Azure reads, and the Terraform, OpenTofu, Pulumi, CDK, Bicep, Ansible and Crossplane previews) **do not inherit your shell's credentials or `HOME`**, and are found in approved directories rather than via `PATH`. Give them a dedicated, narrowly scoped identity with `ALZ_DISCOVERY_<VARIABLE>` variables, and add non-standard tool locations with `ALZ_TOOL_DIRS`. See `docs/runner-hardening.md` for the full convention and what changed.
