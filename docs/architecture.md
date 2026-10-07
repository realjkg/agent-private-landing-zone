# Agent Private Landing Zone architecture

This document is the architectural source of truth for the accelerator. It reconciles the current runtime on main with the recovery-profile direction captured in PR #28.

The design goal is a small sovereign control plane that turns customer intent into governed, evidence-backed platform actions without requiring the customer to operate the internal machinery.

## Core architecture rule

The architecture follows one control path:

~~~text
Customer intent
      ↓
Intent compiler
      ↓
Compiled target + policy metadata
      ↓
Existing security policy interface
      ↓
Capability / data / egress gates
      ↓
Existing typed adapters
      ↓
Normalized evidence
      ↓
Verification / drift / recovery automation
~~~

Recovery declares intent. It does not create a second policy engine.

The existing security policy interface decides whether work is allowed. The existing capability, data-handling and egress gates enforce that decision. Existing typed adapters perform bounded work. Evidence proves what happened.

Models may explain, compare, summarize and recommend. Models are never the source of authority.

ACT = DISABLED remains a repository invariant.

## Deterministic execution sequence

Repository and orchestration work follows one sequence:

~~~text
PLAN
  ↓
parallel DO lanes with non-overlapping ownership
  ↓
CONVERGE / VERIFY
  ↓
single ACT boundary
~~~

PLAN is serialized and authoritative for an iteration. Independent DO lanes may execute in parallel only inside their assigned scopes. CONVERGE/VERIFY is serialized and evidence-driven. A bounded lane failure returns to that DO lane; a changed architecture, policy intent, ownership boundary, or source assumption requires a new PLAN.

ACT is a single authority boundary. For repository engineering it is the controlled integration/merge decision. For infrastructure runtime, ACT remains disabled.

## What stays deliberately small

The accelerator does not introduce a database, queue, distributed scheduler, mandatory daemon, mandatory container, policy SaaS, OPA SDK, second policy engine, SOC/SIEM, malware product, vault product or network controller.

The orchestration layer remains thin. Its responsibility is to compile intent, route bounded work, preserve ownership, carry evidence and enforce deterministic decisions.

OPA is an optional local policy evaluator behind the existing SecurityPolicyEvaluator contract. BUILTIN remains the low-footprint default. Selecting OPA does not change the rest of the architecture.

When OPA is explicitly selected, failure to obtain a valid local decision fails closed.

## Customer experience is part of the architecture

The customer expresses intent. The accelerator owns compilation details.

A normal operator must not be required to author Rego, compiled RecoveryTargetSpec structures, hashes, evidence-lineage records, or capability leases.

Basic target setup must require no more than seven meaningful answers. More advanced controls use progressive disclosure.

The intended operator concepts are:

~~~text
target init
target check
target explain
recovery status
recovery test
~~~

They extend the existing ./alz launcher rather than creating a competing CLI.

Normal output is plain language. Policy IDs, hashes, lineage and low-level evidence belong behind explicit details/evidence views.

Every validation failure should explain:

~~~text
problem
recommended fix
optional safe alternative
confirmation that no infrastructure changes were made
~~~

A recovery test defaults to an isolated non-production preview.

## Composable profile model

Profiles are independent axes. They are not a single maturity or environment enum.

~~~text
organization: STARTUP | ENTERPRISE
environment:  DEVELOPMENT | PRODUCTION
criticality:  NON_CRITICAL | BUSINESS | CRITICAL
compliancePacks: versioned string[]
~~~

This allows a startup to operate a critical production target and an enterprise to operate a non-critical development target without forcing either into an artificial tier.

Profile composition order is locked:

~~~text
locked security baseline
      +
organization defaults
      +
environment defaults
      +
criticality defaults
      +
compliance overlays
      +
authorized customer overrides
      ↓
compiled recovery policy intent
~~~

Profiles never grant capabilities. A profile can require a capability, but capability issuance remains external, scoped, revocable and governed by the existing capability layer.

### Development is not a weaker security mode

DEVELOPMENT inherits every locked security control.

Development may use less stringent continuity economics, such as longer RPO/RTO targets or shorter retention, but it does not weaken secret handling, data classification, egress restrictions, identity/least privilege, compromise containment, evidence integrity, or authority boundaries.

Development is segmented from production/build/release trust domains. Production data is prohibited in development by default.

Promotion from development to production is not a label change. The target is recompiled against production defaults and the accelerator emits a semantic policy diff before the promoted target can be accepted.

## Intent compiler

The compiler is deterministic and side-effect free.

Its inputs are the small customer-facing target definition, the selected profile axes, the locked security baseline, optional compliance packs and authorized customer overrides.

Its outputs are:

~~~text
existing RecoveryTargetSpec
        +
optional recoveryMetadata
        +
provenance
        +
semantic policy representation
~~~

The existing RecoveryTargetSpec remains the runtime target contract so current target files and automation remain backward compatible.

recoveryMetadata is compact compiled metadata, not a second runtime authority.

A representative compiled shape is:

~~~yaml
apiVersion: alz.io/recovery/v1
selection:
  organization: STARTUP
  environment: DEVELOPMENT
  criticality: NON_CRITICAL
  compliancePacks:
    - NIST_CSF_2@1

objectives:
  rpoMinutes: 1440
  rtoMinutes: 1440
  retentionDays: 14
  maximumRestoreEvidenceAgeDays: 90

destination:
  placement: PROVIDER_EDGE
  targetRef: provider-specific-reference
  encryption: CUSTOMER_MANAGED
  immutable: true
  minimumHealthyCopies: 1
  minimumFailureDomains: 1
  centralControlCanDecrypt: false

automation:
  captureEveryMinutes: 1440
  verifyEveryMinutes: 1440
  drillEveryMinutes: 129600
  driftEveryMinutes: 1440
  restoreMode: ISOLATED_PREVIEW
  productionMutation: false

policy:
  evaluator: INHERIT
  decisions:
    capture: recovery/capture
    verify: recovery/verify
    drill: recovery/drill
    drift: recovery/drift
    restore: recovery/restore

provenance:
  targetSchemaVersion: 1
  profileCatalogVersion: 1
  compilerVersion: "1"
  baselineDocumentHash: sha256
  compiledTargetHash: sha256
  compiledPolicyHash: sha256
~~~

Compiled metadata is hash-bound to the inputs used to produce it.

## Locked security baseline

The recovery-profile phase adds a versioned security-baseline document under config/.

The document uses strict machine-readable YAML front matter followed by human-readable Markdown.

Only validated front matter contributes to policy compilation. Prose can explain intent but can never grant authority.

The locked baseline maps into existing policy contracts and includes, at minimum:

~~~text
least privilege
opaque secret references; no secret values in model/operator context
data classification and deterministic minimization
default-deny egress
customer-controlled encryption
provider-edge recovery intent
central control plane cannot decrypt recovery payloads
isolated preview restore by default
tamper-evident evidence lineage
compromise-state containment
ACT disabled
~~~

Customer customization is an overlay. It cannot silently weaken a locked control. Any permitted override must be explicit, authorized, provenance-bound and visible in semantic diff output.

## Policy architecture

There is one decision interface:

~~~text
SecurityPolicyEvaluator
        │
   ┌────┴────┐
   │         │
BUILTIN     OPA
default     optional local evaluator
~~~

The profile compiler does not become a policy evaluator.

Compliance packs do not become policy engines.

The six platform policy pillars do not grant execution authority.

Their responsibilities remain distinct:

~~~text
Profile compiler
  determines declared intent and required posture

Pillar policy bundle
  describes security, cost, resiliency, reliability,
  performance and sustainability requirements/evidence

Security policy evaluator
  makes deterministic allow/deny/obligation decisions

Capability/data/egress gates
  enforce authority and information-flow constraints

Typed adapters
  execute bounded read/preview operations

Evidence
  proves decisions, artifacts and results
~~~

## Compliance packs

Compliance packs are versioned overlays such as framework@version.

They map existing technical controls and evidence requirements to a framework. They do not claim that the customer is compliant merely because a pack is selected.

A compliance pack may require stricter objectives, additional evidence classes, stronger retention/immutability, control mappings, or block a target when required evidence is UNKNOWN.

A compliance pack may not grant a capability, bypass a locked security control, enable production mutation, or replace the security policy evaluator.

This keeps startup and regulated deployments on the same architecture. Regulated environments add policy/evidence depth rather than a second product.

## Recovery destination and sovereignty

The preferred recovery architecture is provider-edge and customer-controlled.

The control plane may coordinate recovery, but it must not require access to plaintext recovery payloads.

The compiled destination model therefore carries intent such as:

~~~text
placement: PROVIDER_EDGE
encryption: CUSTOMER_MANAGED
centralControlCanDecrypt: false
immutability: required when profile/policy demands it
healthy-copy and failure-domain objectives
~~~

The current local encrypted evidence vault remains an evidence mechanism. It must not be represented as provider-native backup proof.

Provider-native backup/export is only considered present when an explicit adapter produces or verifies the corresponding artifact.

If a future provider-native operation requires write authority, that authority must be separately designed, externally granted and narrowly scoped. It must not be smuggled in through a profile or treated as general ACT authority.

## Automated recovery flow

The normal recovery cycle is noninteractive.

~~~text
validated compiled target
        ↓
due-work planner
        ↓
security policy decision
        ↓
capability / data / egress gates
        ↓
capture adapter
        ↓
verify
        ↓
isolated restore drill
        ↓
drift comparison
        ↓
encrypted evidence + lineage
        ↓
next scheduled evaluation
~~~

Chat and CLI are inspection, explanation, setup and troubleshooting surfaces. They are not required to keep the recovery cycle running.

The compromise lifecycle remains:

~~~text
NORMAL → SUSPECTED → CONTAINED → RECOVERY → VERIFIED
~~~

Behavior is deterministic:

~~~text
NORMAL      evaluate normally
SUSPECTED   suspend scheduled recovery work and reduce capabilities
CONTAINED   remain isolated; evidence read/validation only
RECOVERY    allow only bounded recovery-safe operations
VERIFIED    resume normal evaluation
~~~

A profile cannot override this lifecycle.

## Restore semantics

A recovery test defaults to ISOLATED_PREVIEW.

A restore test answers what would be restored, from which source of truth, with which adapter, what is reusable/configurable/additive/no-touch, what evidence is missing, what would block recovery, and whether the recovery point still matches the approved DesignSpec.

It produces evidence but performs no production mutation.

A manifest is not a backup. A configuration inventory is not a restore. A preview is not proof of successful production recovery.

Those distinctions remain explicit in evidence and operator output.

## Evidence and provenance

Compiled policy and recovery operations are evidence-linked.

The target compiler records provenance sufficient to answer:

~~~text
which target input was compiled
which profile catalog version was used
which locked baseline version/hash was used
which customization was applied
which compiled target/policy hash was approved
which DesignSpec/source commit the target references
which policy decision authorized each operation
which evidence resulted
~~~

Evidence lineage remains tamper-evident.

Signing may be added behind the evidence contract later, but the architecture does not claim hardware-backed signing until such an implementation exists.

## Platform policy pillars

The DesignSpec continues to carry the six-pillar policy bundle:

~~~text
Security
Cost
Resiliency
Reliability
Performance
Sustainability
~~~

Recovery profiles primarily refine resiliency and reliability intent, but their requirements can affect other pillars.

Examples:

~~~text
Security
  encryption, isolation, egress, secret handling, compromise behavior

Cost
  retention economics, copy count, provider-edge storage posture

Resiliency
  RPO/RTO, retention, copies, failure domains, restore readiness

Reliability
  restore evidence freshness, verification/drill cadence

Performance
  recovery-time evidence where measured

Sustainability
  retention/copy lifecycle efficiency without inventing carbon claims
~~~

UNKNOWN remains UNKNOWN.

## Platform Landing Zones and future App Landing Zones

The current recovery scope is platform/control-plane configuration recovery. It is not application-data backup.

The architecture is intentionally reusable for future App Landing Zones because the stable contracts are generic:

~~~text
intent
compile
policy
capabilities
adapter
evidence
verification
~~~

An App Landing Zone can introduce application-specific target schemas and adapters without replacing the sovereign orchestrator or policy interface.

No App Landing Zone maturity claim should be made until those contracts are implemented and tested.

## Thin sovereign orchestrator

The orchestrator coordinates specialist work but is not a distributed multi-agent fabric.

Its stable responsibilities are:

~~~text
task envelope
agent registry
ownership/no-collision claims
capability leases
typed evidence handoff
deterministic policy routing
ABSTAIN/BLOCKED escalation
~~~

Specialist agents remain bounded:

~~~text
Discovery
Security
Cost
Resiliency
Reliability
Performance
Sustainability
Architecture
Build
Validator
~~~

Agents reason over evidence. They do not manufacture evidence or authority.

## Release gates

A recovery-profile release is not complete merely because target types compile.

The release gate includes:

~~~text
customer can initialize a target with <= 7 meaningful answers
compiled target is deterministic
locked security baseline cannot be weakened silently
development → production recompilation produces semantic diff
profile selection cannot grant capability
OPA mode remains local and fail-closed
BUILTIN remains functional without OPA
recovery status is plain-language by default
recovery test is isolated/non-mutating by default
automated recovery can run without an interactive session
AWS and Azure deterministic fixtures remain supported
provider-native backup claims require explicit evidence adapters
ACT remains disabled
~~~

During implementation, use the smallest deterministic tests needed. Live private-model and full supply-chain qualification remain release-boundary checks, not per-PR development loops.

## Architectural boundary

The accelerator should become easier to adopt as controls become stronger.

That means complexity is compiled and enforced internally rather than pushed onto the customer.

The durable architecture is:

~~~text
simple intent
→ deterministic compilation
→ one policy interface
→ explicit capability/data/egress enforcement
→ typed provider/IaC adapters
→ automated verification
→ evidence-backed operation
~~~

That is the foundation for a startup-friendly default and a regulated deployment posture without maintaining separate products or separate control planes.
