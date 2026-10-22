# Cost and security evidence sequence (PLAN_ONLY)

This is a lightweight, offline evidence intake and mapping utility. It does **not** install OpenCost, Grafana, Prometheus, or OpenTelemetry, make cloud API calls, or claim actual billed amounts.

1. **Discover:** import RVTools-exported CSV or inventory JSON. Preserve input SHA-256 for local evidence integrity. Native RVTools XLSX requires a CSV export for this first slice.
2. **Financial:** import CSV/JSON from billing (including FOCUS) and hardware/license/power inventories. All amounts are unverified pending source, currency, period and allocation checks; never equate estimates with bills.
3. **Security governance:** import a JSON object with separate `opa`, `scp`, and `rcp` surfaces. An omitted surface is UNKNOWN, not SATISFIED. AWS SCP governs principal permissions and RCP governs resource permissions; OPA is a separate policy-as-code enforcement plane. No false equivalence is inferred.
4. **Greenfield:** generate proposed policy intent for operator review, without generating enforceable policy code or enabling ACT.

Run: `python3 scripts/alz-evidence-sequence.py --inventory path/to/rvtools.csv --financial path/to/focus.csv --policies path/to/policies.json --output .runs/alz-evidence-sequence.json`

In the local operator UI, open **Operations → Cost evidence and observability** to answer contextual questions and export a matching plan-only intake. The file uses a single Grafana/Prometheus/OTel stack, with conditional OpenCost adapter, excludes DrMigrate and Ratio, and never provisions resources.

Never upload secret-bearing policy documents or cost records into third-party systems. Keep imports tenant-scoped; redact confidential details before external sharing. Synthetic fixtures do not prove AWS policy coverage, vendor compatibility, pricing, or production readiness.
