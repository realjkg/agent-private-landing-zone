# Evidence-to-cost-dashboard acceptance (PLAN_ONLY)

The next slice is a local, auditable file pipeline. **No cloud or monitoring system is installed or modified.** Use the existing Operations guided intake to prepare the operator's plan.

## Imports
- **RVTools:** export the `vInfo` worksheet as CSV. Inventory proves VM presence; it never proves costs.
- **FOCUS:** CSV must contain `BilledCost`, `BillingCurrency`, `ChargePeriodStart`, `ChargePeriodEnd`. Values must be USD and have valid time windows. This is **imported billed data, not independently reconciled provider actuals**.
- **Assets:** CSV columns `cost_category,resource_id,monthly_usd,allocation_basis`; category is `hardware`, `licensing` or `facilities`. These are monthly allocated estimates until substantiated by records.
- **Security:** offline OPA JSON and AWS SCP/RCP JSON may be assessed with `scripts/alz-policy-coverage.py`. The existing read-only AWS collector gathers policy attachments. It does not evaluate effective policy decisions or replace OPA evaluation.

## Commands
```bash
python3 scripts/alz-cost-import.py --rvtools /private/vInfo.csv --focus /private/focus.csv --assets /private/assets.csv --output .runs/financial-evidence.json --prometheus-output .runs/cost-estimates.prom
python3 scripts/alz-grafana-dashboard.py --output .runs/grafana-cost-dashboard.json
python3 scripts/alz-policy-coverage.py --input /private/policy-evidence.json --output .runs/governance-coverage.json
python3 -m unittest discover -s test -p 'alz-cost-acceptance.test.py'
```

The Prometheus exposition file requires a *separately reviewed and configured* local textfile exporter/collector to expose metrics. Grafana dashboard JSON requires an existing Grafana with a compatible Prometheus datasource. Neither provisioning action is performed by these scripts. Do not submit provider billing rows as metric labels.

## Non-acceptance / pending
- No native RVTools XLSX parser, UI direct file upload, authenticated server-side ingestion, or browser-to-Grafana connection.
- No automated OPA live-store discovery, substantive policy evaluation, effective SCP/RCP interpretation, or tested cross-platform enforcement translation.
- No automatically joined financial period totals across unlike sources; no reconciliation to actual bills.
- No tested live Grafana, Prometheus or OpenTelemetry deployment.
- ACT stays DISABLED; financial data, including old $14.75 AWS account-wide usage, cannot authorize deployment or $80-credit spend.

All evidence remains within the operator's private environment. Do not commit real billing exports, policies or secrets.
