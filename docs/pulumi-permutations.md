# Pulumi — traceable provider × estate × execution × pillar test matrix

**Release gate:** all entries below are **planned test contracts**, not passing evidence until a source-commit-linked CI run executes `test/pulumi-permutations.test.ts`. Prior run 37869334831 (333 passing tests) did **not** exercise these additional Pulumi combinations.

## 1. Complete existing Pulumi catalog surface

The Pulumi plugin catalog advertises **AWS, AZURE, PRIVATE and KUBERNETES**. Only AWS and Azure are recognized by the current ALZ discovery and agent-kernel Provider types. We do not silently expand that contract.

| Stable case ID | Provider | Estate | Direct kernel | Conversational | Current acceptance |
| --- | --- | --- | --- | --- | --- |
| pulumi-aws-greenfield | AWS | Greenfield | Offline fixture | Offline fixture | Test required |
| pulumi-aws-brownfield | AWS | Brownfield | Offline fixture | Offline fixture | Test required |
| pulumi-aws-unknown | AWS | Unknown ownership | Expected BLOCKED | Expected BLOCKED | Test required |
| pulumi-azure-greenfield | Azure | Greenfield | Offline fixture | Offline fixture | Re-test existing Phase E contract |
| pulumi-azure-brownfield | Azure | Brownfield | Offline fixture | Offline fixture | Test required |
| pulumi-azure-unknown | Azure | Unknown ownership | Expected BLOCKED | Expected BLOCKED | Test required |
| pulumi-private-greenfield | Private | Greenfield | NOT_RUN | NOT_RUN | PLAN_REQUIRED |
| pulumi-private-brownfield | Private | Brownfield | NOT_RUN | NOT_RUN | PLAN_REQUIRED |
| pulumi-private-unknown | Private | Unknown | NOT_RUN | NOT_RUN | PLAN_REQUIRED |
| pulumi-kubernetes-greenfield | Kubernetes | Greenfield | NOT_RUN | NOT_RUN | PLAN_REQUIRED |
| pulumi-kubernetes-brownfield | Kubernetes | Brownfield | NOT_RUN | NOT_RUN | PLAN_REQUIRED |
| pulumi-kubernetes-unknown | Kubernetes | Unknown | NOT_RUN | NOT_RUN | PLAN_REQUIRED |

The **EDGE** provider is not advertised by the Pulumi plugin and is not part of the Pulumi test surface. Private and Kubernetes are visible as explicit PLAN requirements—not passed, rejected scenarios or ordinary nonapplicable tests.

## 2. Expected row-level traceability

`src/qualification/pulumi-traceability.ts` generates **one independently inspectable row per assertion**, never merely a total. Stable IDs use:

`PULUMI:<PROVIDER>:<ESTATE>:<GATE>:<DIMENSION>`

For each of four admissible AWS/Azure greenfield/brownfield combinations:

- DIRECT_DESIGN_PREVIEW and CONVERSATIONAL_DESIGN_PREVIEW: both must produce materially identical canonical DesignSpec, evidence-linked policy and deterministic **fixture-generated** Build Preview. Preserve each lane's unique design hash.
- NO_MUTATION: explicit action-executed/mutation/ACT observations; unknown observations fail.
- CHAOS_INJECTION × 11: missing backup, corrupted manifest, missing IaC state, stale design, unknown RPO/RTO, telemetry outage, synthetic budget spike, synthetic latency regression, synthetic idle-resource waste, unauthorized mutation and single-failure-domain. All are expected **CONTAINED** for Pulumi's stateful recovery policy. Expected outcomes are defined independently of observed outcomes.
- WELL_ARCHITECTED_POLICY × 7: Reliability, Recovery, Security, Cost, Performance, Sustainability and Operational Excellence. A row means **ASSESSED** only; it does not assert a satisfied real-world operating objective. Operational Excellence may remain UNKNOWN.
- LIVE_NOT_RUN × 8: Qwen/Mistral inference, Pulumi CLI validation, actual Pulumi provider preview, actual cloud discovery, physical restore, measured cost, measured performance and measured sustainability. The expected acceptance is future PASS but the observed status stays NOT_RUN until real evidence exists.

For each AWS/Azure UNKNOWN estate combination: one direct and one conversational **BLOCKED** row; no candidate and no ACT.

For each PRIVATE/KUBERNETES estate combination: one **PLAN_REQUIRED** contract row. Do not infer a working kernel or call it a passing test.

**Expected offline report after successful verification:** 126 trace rows = 88 evidence-backed offline assertions + 32 live NOT_RUN + 6 PLAN_REQUIRED; 44 fault injections across the four allowed estate/provider scenarios. Any missing observation hash or contradicted expectation is FAILED and blocks the campaign. The report counts remain expected, not verified, until the run finishes.

## 3. Evidence schema and execution

From a clean exact repository commit with dependencies available:

```sh
npm ci && npm run build
node dist/cli/pulumi-permutations.js
```

Creates private `.runs/qualification/pulumi-permutations/pulumi-<id>.json` and matching `.csv` (mode 0600). Each row carries ID, provider, estate, gate, dimension, expected outcome, actual observed outcome, verdict, phase, source SHA, source test, evidence-mode classification, observed hash if executed, and row SHA256. The report carries its own hash. Link the exact GitHub Actions run and artifact/commit in Issue #39; a planned test name or green suite count alone is insufficient proof.

**Offline mode:** real deterministic ALZ application code, synthetic discovery and fixture thinker. No Pulumi executable runs. The generated IaC candidate is a fixture, NOT a model-generated or Pulumi provider plan. No AWS or Azure cloud resources are contacted or changed.

**Live mode is last:** separately verify Qwen router/primary and Mistral validator digests, real Pulumi CLI/program validation, bounded provider preview, cloud inventory ownership, restore RPO/RTO and Well-Architected metrics for each approved combination. Do not elevate any row until its own execution evidence is captured.

## 4. Exit criteria and change control

- Zero FAILED rows for offline-executed assertions.
- All four admissible provider/estate combinations fully traced through direct + conversational + chaos/pillar checks.
- Both UNKNOWN scenarios correctly blocked.
- Six unimplemented kernel-provider cases remain PLAN_REQUIRED and excluded from any claim of test completion.
- Live rows remain UNVERIFIED, never passed by offline unit tests.
- No new providers, model families, IaC adapters, distributed-agent frameworks or mutation scope in close-out. Any architecture, authority or deployment-contract change returns to PLAN.
- Failures are recorded in VERIFY and fixed only in the owning DO branch. Avoid repeated heavyweight CI runs; consolidate changes before standard validation.
