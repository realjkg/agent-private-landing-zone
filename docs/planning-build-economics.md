# Cost-efficient planning and building

**Objective:** decrease the total economic cost of an *equivalent verified planning/build outcome* across AI inference, infrastructure and local engineering compute, without reducing security, policy fidelity, recoverability, or answer/plan quality.

The existing monthly economics report summarizes costs and forecasts. The new `comparePlanningBuildCost` compares a baseline and candidate workflow for one workload fingerprint and explicit expected outcome. It accepts evidence-referenced USD cents, partitions costs into `AI_INFERENCE`, `INFRASTRUCTURE`, and `ENGINEERING_RUNTIME`, and computes lane deltas and total basis points.

- `OBSERVED_REDUCTION` = both runs carry costs **declared** observed with equivalent-outcome attestations. The module does not fetch bills or independently verify receipts; the invoice savings field remains false.
- `ESTIMATE_ONLY` = either run includes estimated costs. Forecasts are not actual savings.
- `NOT_COMPARABLE` = missing outcome attestation, duplicate evidence, invalid source, bad cost, or invalid evidence.
- `OBSERVED_NO_REDUCTION` = observed cost does not decrease; negative deltas are preserved.

## Workflow optimization levers

**AI:** router/engineer/validator model role selection based on qualification, local inference when reliable, strict context caps, cache safe reusable retrieval, bound retry count, reject redundant model calls. Do not cache credentials or policy decisions without source binding.

**Infrastructure:** reuse existing LZA controls and customer resources, avoid duplicate Control Tower/VPC/observability stacks, validate and synthesize IaC locally, favor provider read/preview, prevent idle test resources, and record real billing/compute/network/storage charges.

**Measurement:** capture baseline/candidate inference duration, input/output tokens where applicable, GPU/CPU energy and time if metered, cloud billing export by account/service, temporary-resource TTL, planner/preview latency, and quality/security test results. Include labor cost only when sourced explicitly, not as invented savings. Compare equivalent workloads and source-bound evidence; use actual billing exports for external financial benefit claims.

No actual savings can be inferred from merging LZA PRs #173/#174, running offline tests, or avoiding an unprovisioned hypothetical infrastructure stack. A measured before-and-after workload (same security, resource scope, policies, output criteria) is required. This module is advisory and cannot enable ACT, change cloud budgets or provision resources.

## Suggested release KPIs

Total cost per qualified blueprint, AI spend per accepted design, local compute cost per verified preview, AWS spend per preview, unsuccessful attempt/retry cost, reused-resource count, time-to-qualified-plan, and validation pass rate. Treat these as measured only with provider or local meter evidence; otherwise show estimated/proposed.
