import type {
  MonitoringProviderDefinition,
  MonitoringProviderId,
} from "./types.js";

export const MONITORING_PROVIDERS:
  MonitoringProviderDefinition[] = [
    {
      id: "OTEL_COLLECTOR",
      roles: [
        "TRANSPORT",
        "METRICS",
        "LOGS",
        "TRACES",
      ],
      privateCapable: true,
      supportsDisconnected: true,
      directEventExport: true,
      notes:
        "Local OpenTelemetry Collector binding. Preferred neutral telemetry transport.",
    },
    {
      id: "SPLUNK_HEC",
      roles: [
        "LOGS",
        "SEARCH",
        "ALERTING",
      ],
      privateCapable: true,
      supportsDisconnected: true,
      directEventExport: true,
      notes:
        "Splunk Enterprise HEC may be hosted inside the private sovereign boundary.",
    },
    {
      id: "PROMETHEUS",
      roles: [
        "METRICS",
        "ALERTING",
      ],
      privateCapable: true,
      supportsDisconnected: true,
      directEventExport: false,
      notes:
        "Pull-oriented local metrics and alerting backend.",
    },
    {
      id: "GRAFANA",
      roles: [
        "VISUALIZATION",
        "ALERTING",
      ],
      privateCapable: true,
      supportsDisconnected: true,
      directEventExport: false,
      notes:
        "Self-hosted visualization and alerting layer; binds to local data sources.",
    },
    {
      id: "GRAFANA_LOKI",
      roles: [
        "LOGS",
        "SEARCH",
      ],
      privateCapable: true,
      supportsDisconnected: true,
      directEventExport: false,
      notes:
        "Self-hosted Grafana log backend.",
    },
    {
      id: "GRAFANA_TEMPO",
      roles: [
        "TRACES",
        "SEARCH",
      ],
      privateCapable: true,
      supportsDisconnected: true,
      directEventExport: false,
      notes:
        "Self-hosted Grafana trace backend.",
    },
    {
      id: "GRAFANA_MIMIR",
      roles: [
        "METRICS",
        "ALERTING",
      ],
      privateCapable: true,
      supportsDisconnected: true,
      directEventExport: false,
      notes:
        "Self-hosted long-term Prometheus/OpenTelemetry metrics backend.",
    },
    {
      id: "OPENSEARCH",
      roles: [
        "METRICS",
        "LOGS",
        "TRACES",
        "SEARCH",
        "VISUALIZATION",
        "ALERTING",
      ],
      privateCapable: true,
      supportsDisconnected: true,
      directEventExport: false,
      notes:
        "Self-hosted OpenSearch observability stack with OTLP/Prometheus-compatible ingestion paths.",
    },
    {
      id: "ELASTIC",
      roles: [
        "METRICS",
        "LOGS",
        "TRACES",
        "SEARCH",
        "VISUALIZATION",
        "ALERTING",
      ],
      privateCapable: true,
      supportsDisconnected: true,
      directEventExport: false,
      notes:
        "Self-managed Elastic observability stack; prefer OpenTelemetry ingestion for new integrations.",
    },
    {
      id: "VICTORIAMETRICS",
      roles: [
        "METRICS",
        "ALERTING",
      ],
      privateCapable: true,
      supportsDisconnected: true,
      directEventExport: false,
      notes:
        "Self-hosted Prometheus-compatible metrics backend.",
    },
    {
      id: "ZABBIX",
      roles: [
        "INFRASTRUCTURE",
        "METRICS",
        "ALERTING",
      ],
      privateCapable: true,
      supportsDisconnected: true,
      directEventExport: false,
      notes:
        "Self-hosted infrastructure monitoring for hosts, appliances and traditional private estates.",
    },
  ];

export function monitoringProvider(
  id: MonitoringProviderId,
): MonitoringProviderDefinition {
  const provider =
    MONITORING_PROVIDERS.find(
      (candidate) =>
        candidate.id === id,
    );

  if (!provider) {
    throw new Error(
      "MONITORING_PROVIDER_UNKNOWN: " +
        id,
    );
  }

  return provider;
}
