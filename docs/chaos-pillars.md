# ALZ chaos engineering and pillar evidence — simulation only

Run `./alz chaos` after the operator runtime is bootstrapped, or `node dist/cli/chaos-pillars.js` from a clean committed checkout.

The command uses an **in-memory synthetic AWS brownfield** and the existing deterministic recovery policy, recovery-point, verification and restore-drill logic. It never deletes or corrupts a real backup, stops a live service, executes a restore, or mutates an AWS/Azure resource.

## Eleven fault injections

| Fault | Evidence & expected safe outcome |
| --- | --- |
| Missing backup | Manifest-only coverage remains blocked, never called restored |
| Corrupted recovery manifest | Recovery-point hash comparison fails |
| Missing IaC state | Required IaC state verification fails |
| Stale DesignSpec | Simulated restore drill reports a design-hash mismatch and BLOCKED |
| Unknown RPO/RTO | UNKNOWN prevents recoverability acceptance |
| Telemetry outage | Absent heartbeat plus undocumented on-call/runbook triggers an operations finding |
| Cost budget spike | Explicit **synthetic** $180 forecast exceeds $100 budget; real cloud cost UNKNOWN |
| Performance regression | Explicit **synthetic** 370 ms p95 exceeds 200 ms objective; real performance UNKNOWN |
| Sustainability waste | Explicit **synthetic** 200 idle hours exceeds 50-hour allowance; real utilization and carbon UNKNOWN |
| Unauthorized mutation | An unapproved DELETE is denied by the ACT-disabled invariant |
| Single failure domain | Explicit **synthetic** one zone violates the two-zone target; actual redundancy UNKNOWN |

The existing Well-Architected bundle provides Security, Cost, Resiliency, Reliability, Performance and Sustainability posture. Operational Excellence is recorded separately as **UNKNOWN** until on-call, runbooks, observability, and recovery duties have evidenced coverage. An UNKNOWN pillar cannot be marked SATISFIED.

A `CONTAINED` outcome means a synthetic failure was recognized and did not grant additional authority. It is **not** a pass for real cloud disaster recovery, throughput benchmarking, actual savings, carbon footprint, restore RTO or security certification. A real controlled fault trial needs an isolated authorized environment and operator-led release PLAN.

## Efficiency

This is a single deterministic scenario through the kernel, followed by in-memory fault variations. `test/chaos-pillars.test.ts` provides targeted contract assertions; no network, model downloads, Terraform apply, cloud credentials or repeated GitHub Actions are necessary. Results in `.runs/qualification/chaos-pillars/` include the exact source commit, policy hash, simulated recovery-point hash, fault outcomes and an evidence hash. ACT remains DISABLED.
