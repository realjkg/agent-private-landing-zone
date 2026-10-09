# ALZ pre-live qualification campaign

This release-closeout phase exercises all **eight already supported Phase E adapter scenarios** and their negative controls before any live Qwen/Mistral, AWS/Azure, Terraform provider plan, or physical recovery test.

## Run once from a clean checkout

```sh
./alz bootstrap
node dist/cli/prelive-campaign.js
```

The report is written privately to `.runs/qualification/prelive-campaign/prelive-<run-id>.json`, bound to the source commit and its own SHA256 evidence hash. This is one bounded offline campaign, not a CI matrix with dozens of separately billable jobs.

## Acceptance matrix

Each of the eight existing canonical scenarios runs in direct and conversational fixture modes, checked for approved DesignSpec parity, identical policy/preview evidence and **explicit observed no-mutation** state. Each is then re-run with UNKNOWN estate evidence and must BLOCK both lanes without producing a Build candidate.

For every canonical scenario, the other known provider (AWS or Azure) is checked against the **existing plugin catalog**. If that pairing is not supported, the actual scenario is fault-injected and must fail closed. If the pairing is supported by a generic adapter but not covered by an approved Phase E scenario, the result is **NOT_APPLICABLE**, not a fabricated green result and not a new approved provider/adapter combination.

Every canonical scenario also undergoes all 11 existing in-memory recovery/chaos injections. A missing `IAC_STATE` is **NOT_APPLICABLE** to adapters whose recovery policy does not require one; it is an actual BLOCKED fault only for Terraform, OpenTofu and Pulumi. Missing backup, UNKNOWN RPO/RTO and tampered recovery hashes are injected even if the initial baseline is healthy. Neither `CONTAINED` nor `NOT_APPLICABLE` claims a real restore or production recoverability.

Existing policy evidence covers Security, Cost, Resiliency, Reliability, Performance and Sustainability. Operational Excellence is reported **UNKNOWN** without verified on-call/runbook/telemetry obligations. The cost spike, p95 latency, idle resource hours and failure-domain observations are *synthetic inputs*; actual cloud spend, benchmark throughput, savings, carbon and emissions measurements remain **NOT_RUN**. The only measured performance here is the elapsed time of local deterministic scenario execution, explicitly not a cloud benchmark.

## What remains for the LAST phase

Actual installed model and GPU/edge resource qualification, real Qwen/Mistral routing and independent validation with model digests; real provider discovery and IaC plans; authorized isolated backup and restore drill with RPO/RTO; actual cost/performance/utilization; release security qualification. No live model, network provider call, or infrastructure mutation occurs in this campaign. ACT remains DISABLED.

### Edge-case handling

Missing/duplicate/unknown CLI arguments fail closed. Failing or incomplete lane evidence stays UNKNOWN rather than being displayed as no mutation. A model spoofed under the wrong role cannot satisfy live qualification. Recovery faults are counted per applicable policy rather than credited against unsupported adapters. One source-bound report records each expected BLOCKED and NOT_APPLICABLE result. Failures return to the owning DO lane with source-commit evidence; no fixes occur within VERIFY.
