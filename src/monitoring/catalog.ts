import type {
  MonitoringProviderDefinition,
  MonitoringProviderId,
} from "./types.js";

export const MONITORING_PROVIDERS:
  MonitoringProviderDefinition[] = [
    {
      id: "OTEL_COLLECTOR",
      scope: "BOTH",
      integrationClass:
        "FOUNDATION",
      roles: [
        "TRANSPORT",
        "METRICS",
        "LOGS",
        "TRACES",
        "APM",
      ],
      privateCapable: true,
      supportsDisconnected: true,
      directEventExport: true,
      notes:
        "Portable local OpenTelemetry Collector binding for PLZ and ALZ telemetry.",
    },
    {
      id: "PROMETHEUS",
      scope: "BOTH",
      integrationClass:
        "FOUNDATION",
      roles: [
        "METRICS",
        "ALERTING",
      ],
      privateCapable: true,
      supportsDisconnected: true,
      directEventExport: false,
      notes:
        "Portable Prometheus metrics and alerting backend for platform and application workloads.",
    },
    {
      id: "GRAFANA",
      scope: "BOTH",
      integrationClass:
        "FOUNDATION",
      roles: [
        "VISUALIZATION",
        "ALERTING",
      ],
      privateCapable: true,
      supportsDisconnected: true,
      directEventExport: false,
      notes:
        "Self-hosted visualization and alerting layer over approved local or sovereign-domain data sources.",
    },
    {
      id: "SPLUNK_HEC",
      scope: "BOTH",
      integrationClass:
        "ENTERPRISE",
      roles: [
        "LOGS",
        "SEARCH",
        "ALERTING",
      ],
      privateCapable: true,
      supportsDisconnected: true,
      directEventExport: true,
      notes:
        "Splunk Enterprise HEC binding. May remain completely inside the private sovereign boundary.",
    },
    {
      id: "AWS_CLOUDWATCH",
      scope: "BOTH",
      integrationClass:
        "CLOUD_NATIVE",
      roles: [
        "METRICS",
        "LOGS",
        "TRACES",
        "APM",
        "ALERTING",
        "SEARCH",
      ],
      privateCapable: false,
      supportsDisconnected: false,
      directEventExport: false,
      notes:
        "AWS-native PLZ/ALZ runtime monitoring backend. Prefer OpenTelemetry/ADOT instrumentation feeding CloudWatch.",
    },
    {
      id:
        "AZURE_MONITOR_LOG_ANALYTICS",
      scope: "BOTH",
      integrationClass:
        "CLOUD_NATIVE",
      roles: [
        "METRICS",
        "LOGS",
        "TRACES",
        "APM",
        "ALERTING",
        "SEARCH",
      ],
      privateCapable: false,
      supportsDisconnected: false,
      directEventExport: false,
      notes:
        "Azure-native PLZ/ALZ monitoring and Log Analytics binding.",
    },
    {
      id: "SYSLOG",
      scope: "PLATFORM_LZ",
      integrationClass:
        "PRIVATE_INFRASTRUCTURE",
      roles: [
        "LOGS",
        "INFRASTRUCTURE",
      ],
      privateCapable: true,
      supportsDisconnected: true,
      directEventExport: false,
      notes:
        "Private infrastructure and appliance log integration, normally normalized through a local collector.",
    },
    {
      id: "SNMP",
      scope: "PLATFORM_LZ",
      integrationClass:
        "PRIVATE_INFRASTRUCTURE",
      roles: [
        "METRICS",
        "INFRASTRUCTURE",
        "ALERTING",
      ],
      privateCapable: true,
      supportsDisconnected: true,
      directEventExport: false,
      notes:
        "Private infrastructure/network monitoring binding for devices not natively instrumented with OpenTelemetry or Prometheus.",
    },
    {
      id: "GRAFANA_LOKI",
      scope: "BOTH",
      integrationClass:
        "OPTIONAL_BACKEND",
      roles: [
        "LOGS",
        "SEARCH",
      ],
      privateCapable: true,
      supportsDisconnected: true,
      directEventExport: false,
      notes:
        "Optional self-hosted Grafana log backend.",
    },
    {
      id: "GRAFANA_TEMPO",
      scope: "APPLICATION_LZ",
      integrationClass:
        "OPTIONAL_BACKEND",
      roles: [
        "TRACES",
        "SEARCH",
        "APM",
      ],
      privateCapable: true,
      supportsDisconnected: true,
      directEventExport: false,
      notes:
        "Optional self-hosted trace backend for application workloads.",
    },
    {
      id: "GRAFANA_MIMIR",
      scope: "BOTH",
      integrationClass:
        "OPTIONAL_BACKEND",
      roles: [
        "METRICS",
        "ALERTING",
      ],
      privateCapable: true,
      supportsDisconnected: true,
      directEventExport: false,
      notes:
        "Optional self-hosted long-term Prometheus/OpenTelemetry metrics backend.",
    },
    {
      id: "OPENSEARCH",
      scope: "BOTH",
      integrationClass:
        "OPTIONAL_BACKEND",
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
        "Optional self-hosted search and observability backend.",
    },
    {
      id: "ELASTIC",
      scope: "BOTH",
      integrationClass:
        "OPTIONAL_BACKEND",
      roles: [
        "METRICS",
        "LOGS",
        "TRACES",
        "SEARCH",
        "VISUALIZATION",
        "ALERTING",
        "APM",
      ],
      privateCapable: true,
      supportsDisconnected: true,
      directEventExport: false,
      notes:
        "Optional self-managed Elastic observability backend; prefer OpenTelemetry ingestion for new integrations.",
    },
    {
      id: "VICTORIAMETRICS",
      scope: "BOTH",
      integrationClass:
        "OPTIONAL_BACKEND",
      roles: [
        "METRICS",
        "ALERTING",
      ],
      privateCapable: true,
      supportsDisconnected: true,
      directEventExport: false,
      notes:
        "Optional self-hosted Prometheus-compatible metrics backend.",
    },
    {
      id: "ZABBIX",
      scope: "PLATFORM_LZ",
      integrationClass:
        "OPTIONAL_BACKEND",
      roles: [
        "INFRASTRUCTURE",
        "METRICS",
        "ALERTING",
      ],
      privateCapable: true,
      supportsDisconnected: true,
      directEventExport: false,
      notes:
        "Optional self-hosted infrastructure monitoring for traditional private estates.",
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

export function coreMonitoringProviders(
  scope:
    | "PLATFORM_LZ"
    | "APPLICATION_LZ",
): MonitoringProviderDefinition[] {
  return MONITORING_PROVIDERS.filter(
    (provider) =>
      provider.integrationClass !==
        "OPTIONAL_BACKEND" &&
      (
        provider.scope === "BOTH" ||
        provider.scope === scope
      ),
  );
}
