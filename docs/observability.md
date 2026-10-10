# Observability

The landing zone runtime reports on itself. Structured operational events, loopback health/readiness/metrics endpoints, a one-shot health command, and versioned alert rules ship in the box — no standing monitoring stack, no new runtime dependencies, and observability failures never fail a governed command.

The behavior described here is enforced by the production deployment contract's observability block (`structuredLogs`, `healthEndpoint`, `readinessEndpoint`, `secretRedaction`, and eight named signals), checked against runtime evidence rather than configuration presence. See `src/qualification/production-contract.ts`.

## Operational events

Every governed command path emits schema-versioned operational events through one process-local bus (`src/observability/bus.ts`). Events are best-effort by construction: a sink, registry, or export failure degrades to a warn line and never interrupts the command that emitted the event.

An event looks like this on stdout:

```json
{"schemaVersion":1,"at":"2026-10-10T12:00:00.000Z","signal":"policy-denials","status":"BLOCKED","component":"agent/graph","detail":"...","attributes":{}}
```

Fields: `schemaVersion` (always `1`), `at` (ISO timestamp), `signal`, `status`, `component`, optional `durationMs` and `detail`, and an `attributes` map. All text and attributes pass through secret redaction before any consumer — including the export path — sees them.

### Signal catalog

Eleven signals are defined in `src/observability/events.ts` (`PRODUCTION_SIGNALS`). The first eight are required by the production deployment contract; the three economics signals ride the same bus.

| Signal | What it reports | Typical statuses | Emitted from |
| --- | --- | --- | --- |
| `model-latency` | Duration of local model calls | OK / DEGRADED | `src/ollama.ts` |
| `model-restarts` | Model runtime restart-recovery outcomes | DEGRADED / FAILED | `src/qualification/model-production.ts` |
| `adapter-failures` | Build adapter run/validate failures | FAILED | `src/plugins/validate.ts`, `src/tools/governed.ts` |
| `policy-denials` | Deterministic policy refusals | BLOCKED | `src/agent/graph.ts`, `src/build/loop.ts`, `src/loop.ts`, `src/recovery/automation.ts` |
| `provider-discovery-health` | Read-only provider discovery probe outcomes | OK / DEGRADED / FAILED | `src/discovery/discover.ts`, `src/environment/read-only.ts` |
| `recovery-state` | Recovery capture/verify/drill/drift transitions | OK / FAILED | `src/recovery/automation.ts` |
| `recovery-objective-status` | RPO/RTO objective evaluation | OK / DEGRADED | `src/recovery/profile/operator.ts` |
| `evidence-lifecycle` | Evidence vault writes, migration, hash-link events | OK / FAILED | `src/evidence/vault.ts`, `src/evidence/migrate.ts` |
| `economics-budget` | Budget evaluation against observed spend | OK / FAILED | `src/economics/report.ts` |
| `economics-anomaly` | Month-over-month anomaly comparison | OK / DEGRADED | `src/economics/report.ts` |
| `economics-forecast` | Closed-month trailing-average forecast | OK / FAILED | `src/economics/report.ts` |

### Statuses

Four statuses (`OPERATIONAL_EVENT_STATUSES`), and they are the vocabulary alert rules key on:

| Status | Meaning | Default alert posture |
| --- | --- | --- |
| `OK` | Healthy occurrence — heartbeat, successful capture, forecast recorded | Metric only; no alert rule |
| `DEGRADED` | Soft threshold breached — latency, cost anomaly, objective miss | Warning over a sustained window |
| `BLOCKED` | Governance refused — policy denial, boundary enforcement | Warning per occurrence, critical on rate |
| `FAILED` | Operation failed — adapter error, restart, probe failure | Critical at first occurrence |

### Secret redaction

Events are built only through `createOperationalEvent` (`src/observability/events.ts`), which applies `src/observability/redaction.ts` before any consumer sees the event:

- Private key blocks become `[REDACTED PRIVATE KEY]`.
- Bearer tokens become `Bearer [REDACTED]`.
- `key=value` / `key: value` assignments with secret-like keys (`secret`, `password`, `token`, `authorization`, `api_key`, `access_key`, `private_key`, `credential`, case-insensitive) become `key=[REDACTED]`.
- Attribute keys matching the same sensitive-name pattern are replaced with `[REDACTED]`; strings are sanitized in place; nested arrays and objects are walked recursively.
- `detail` text is sanitized and capped at 512 characters.

## Configuration

Configured through environment variables (`src/config.ts`, `loadObservabilityConfig`; documented in `.env.example`). The default posture is **on**: structured events flow to stdout with no configuration at all.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ALZ_OBSERVABILITY_EVENTS` | `true` | Set `false` to disable the stdout JSON-line sink. Values other than `true`/`false` (case-insensitive) fail toward the default — events stay on — with a warn line. |
| `ALZ_HEALTH_HOST` | `127.0.0.1` | Fixed. Any other value is **refused, never honored**: a warn line explains, and the health server binds `127.0.0.1` only. Loopback-only is a sovereignty requirement. |
| `ALZ_HEALTH_PORT` | unset (ephemeral) | Optional fixed port for the health server. Must be an integer 0–65535; invalid values are ignored with a warn. Unset (or `0`) binds a random free port. |
| `ALZ_MONITORING_PROVIDER` | unset (export off) | `OTEL_COLLECTOR` or `SPLUNK_HEC` — the only direct-event-export providers. |
| `ALZ_MONITORING_DEPLOYMENT` | unset | `LOCAL`, `SOVEREIGN_DOMAIN`, or `EXTERNAL`. |
| `ALZ_MONITORING_ENDPOINT` | — | Required when any `ALZ_MONITORING_*` variable is set; both providers export events directly. |
| `ALZ_MONITORING_AUTH_REF` | unset | Opaque reference only: `secret://`, `vault://`, or `keyring://`. Raw credentials are refused. Required for `SPLUNK_HEC`. |

Invalid values never crash startup: each produces one `[warn] OBSERVABILITY_CONFIG_INVALID: ...` line on stderr. A structurally invalid monitoring binding is dropped (export stays off) while the event stream stays on. Parsing is structural only — profile sovereignty is enforced separately, at the bus export gate, so a structurally valid binding that violates the runtime profile still fails closed before any event leaves the process.

All warn/diagnostic lines go to **stderr**; event JSON lines go to **stdout**, so they can be captured independently.

## Health, readiness, and metrics endpoints

`src/observability/health.ts` serves three GET-only routes on a loopback-bound server:

| Route | Response | Body |
| --- | --- | --- |
| `/healthz` | `200` always | `{"healthy":true,"service":"agent-private-landing-zone","operatingMode":"PREVIEW_OPERATE","actEnabled":false}` |
| `/readyz` | `200` ready, `503` not ready | `{"ready":<bool>,"checks":[...],"actEnabled":false}` |
| `/metrics` | `200` | Prometheus text exposition format (`text/plain; version=0.0.4; charset=utf-8`) |

- JSON routes are served with `cache-control: no-store`. Non-GET requests get `405`; unknown paths get `404`.
- `/readyz` folds the host runtime's own readiness checks together with the production-contract observability verdict, surfaced as a `production-contract-observability` check that reports exactly which contract requirement is unmet when it fails.
- `/metrics` renders the bus registry: `alz_operational_event_total` is a **counter** — a monotonic total aggregated by `signal`, `status`, and `component` labels — and `alz_operational_event_duration_milliseconds` is a **gauge** carrying the most recent observed duration for each label set. There are no per-event samples.

### Loopback-only binding

The bind guard accepts only `127.0.0.1`, `localhost`, or `::1`; any other host throws `HEALTH_ENDPOINT_BIND_DENIED: production health endpoints are loopback-only.` and the config layer refuses conflicting `ALZ_HEALTH_HOST` values outright. The endpoints are probe surfaces for the operator on the same machine — never a network listener.

### Which runtimes serve

- `./alz operator-web` and `./alz session` are long-running runtimes: they boot the health server at startup and print its address (for example `Observability http://127.0.0.1:53712 (loopback-only /healthz /readyz /metrics)`; the session prints `Health <address>`).
- One-shot commands do not serve. Their readiness evidence simply omits endpoint claims — an unserved endpoint is "not evaluated", never a failure.

### Fail-safe boot

A taken `ALZ_HEALTH_PORT` or a bind refusal produces exactly one `[warn] OBSERVABILITY_HEALTH_SERVER_DISABLED: ...` line; the operator web UI or session keeps serving its product surface, and structured events stay on. Observability can never take the host runtime down.

## The `./alz health` command

```bash
./alz health          # one-shot report
./alz health --serve  # serve the loopback endpoints
```

One-shot output is a human-readable report: the health line (operating mode `PREVIEW_OPERATE`, ACT `DISABLED`), a `readiness: READY` / `NOT READY` line with one `✓`/`✗` line per check, and the effective configuration echo (structured events on/off, health server posture, monitoring export binding or "not configured (opt-in)").

- **One-shot:** exit `0` when ready, `1` when not ready (or on error). Does not serve.
- **`--serve`:** prints the same report, then serves `http://127.0.0.1:<port>` until Ctrl+C (clean close, exit `0`). If the server could not bind, the command prints `Health server is not serving; see the diagnostics line above.` and exits `1`.

`./alz health` is the quickest answer to "does the runtime think it is healthy, and is the contract's observability block actually enforced in this process?"

## Alert rules

Alert postures are versioned config, not tribal knowledge: `config/alert-rules.yaml`, loaded and validated by `src/monitoring/alert-rules.ts`.

```yaml
apiVersion: alz.io/alert-rules/v1
kind: AlertRules
rules:
  - id: adapter-failure
    signal: adapter-failures
    forStatus: FAILED
    threshold: 1
    window: 5m
    severity: critical
  # ... 12 rules total, covering all 11 signals
```

**Semantics.** A rule fires when `threshold` occurrences of `signal` events with status `forStatus` are observed within `window`. Fields:

| Field | Constraint |
| --- | --- |
| `id` | Unique, non-empty; duplicates are rejected |
| `signal` | Must be a member of `PRODUCTION_SIGNALS` |
| `forStatus` | One of `OK`, `DEGRADED`, `BLOCKED`, `FAILED` |
| `threshold` | Integer ≥ 1 |
| `window` | `Ns` / `Nm` / `Nh` (e.g. `5m`, `15m`) |
| `severity` | `critical` or `warning` |

Rules are provider-neutral. A Prometheus/Alertmanager or Grafana alerting equivalent can be derived mechanically from them; nothing here deploys or requires a backend (see Non-goals in the spec, "Turning On Observability Controls").

**Validation and CI guard.** The loader enforces a strict schema: unknown fields fail, unknown signals or statuses fail, and malformed YAML shapes fail with a precise location — `ALERT_RULES_INVALID: config/alert-rules.yaml line N: <reason>`. The parser accepts a deliberately constrained YAML subset (top-level scalars plus one flat list of flat maps; no anchors, nesting, or flow syntax) so failures are exact rather than coerced. In CI, `test/monitoring-alert-rules.test.ts` parses the shipped file and asserts `uncoveredSignals()` is empty — **every production signal must keep at least one rule**, so a renamed signal cannot orphan its rules silently. `OK` is heartbeat posture (metric only) and carries no rule by design; the coverage bar is "at least one rule per signal", which the shipped file satisfies for all 11 signals.

## Monitoring export (opt-in)

By default events live on stdout only. To point a collector at them, configure the binding and let the runtime validate it:

```bash
# OTLP collector on the same machine (example from .env.example)
export ALZ_MONITORING_PROVIDER=OTEL_COLLECTOR
export ALZ_MONITORING_DEPLOYMENT=LOCAL
export ALZ_MONITORING_ENDPOINT=http://127.0.0.1:4318

# or Splunk HEC
export ALZ_MONITORING_PROVIDER=SPLUNK_HEC
export ALZ_MONITORING_DEPLOYMENT=LOCAL
export ALZ_MONITORING_ENDPOINT=https://splunk.example:8088
export ALZ_MONITORING_AUTH_REF=secret://monitoring/splunk-hec-token
```

**What goes over the wire.** `OTEL_COLLECTOR` posts an OTLP JSON request (`resourceLogs` with `service.name=agent-private-landing-zone`, scope `alz.monitoring`, the full event JSON as the log record body, and `alz.signal` / `alz.component` attributes; severity text is the event status). `SPLUNK_HEC` posts `{"time":...,"host":"agent-private-landing-zone","sourcetype":"alz:operational","event":{...},"fields":{"signal":...,"status":...,"component":...}}`.

**Fail-closed by design.** Nothing leaves the process until the binding passes `validateMonitoringBinding` (`src/monitoring/validate.ts`) against the active runtime profile:

- Strict private-sovereign profiles reject providers that are not private-capable (both `OTEL_COLLECTOR` and `SPLUNK_HEC` are).
- Disconnected profiles require `LOCAL` deployment and a disconnected-capable provider.
- Profiles that prohibit external telemetry reject `EXTERNAL` deployment; same-sovereign-domain profiles reject it as well.
- Direct-event-export providers require an endpoint.
- `SPLUNK_HEC` requires an opaque auth reference; any supplied reference must be `secret://`, `vault://`, or `keyring://`.

The gate is evaluated once per process. A binding that fails — or one configured without a validated gate — disables export for the life of the bus with exactly one warn line on stderr and **no** events sent:

```text
[warn] MONITORING_EXPORT_DISABLED: <reasons...>
```

After that, events continue to stdout, metrics, and readiness as normal — only export is off. A transport-level failure once the gate is open degrades to `[warn] MONITORING_EXPORT_FAILED: ...` per event and never fails the command. Invalid configs (for example a raw credential in `ALZ_MONITORING_AUTH_REF`) are dropped at load time with `[warn] OBSERVABILITY_CONFIG_INVALID: monitoring export binding disabled — ...` instead.

## Chaos-evidence notes

`docs/chaos-pillars.md` records the telemetry-outage fault ("absent heartbeat plus undocumented on-call/runbook triggers an operations finding") and holds Operational Excellence at **UNKNOWN** until on-call, runbooks, observability, and recovery duties have evidenced coverage. Factual answers from this shipped surface, for whoever runs that trial:

- **Heartbeat exists:** loopback `/healthz`, `/readyz`, and `/metrics` serve on the long-running runtimes, `./alz health` reports one-shot, and `/metrics` plus the stdout event stream provide the scrape- and capture-side heartbeat. Absence of the heartbeat is now observable, not assumed.
- **Alert rules are versioned config:** `config/alert-rules.yaml` is schema-validated with a signal-coverage test in CI — the alert half of the finding is documented in-repo, not in someone's head.
- **On-call and runbooks are owner-owned and remain out of scope of this work.** They are still required evidence before Operational Excellence can leave UNKNOWN; this surface supplies the telemetry and alert-rule evidence only.
