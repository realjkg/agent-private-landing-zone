import type {
  OperationalEvent,
} from "../observability/events.js";
import type {
  RuntimeProfileId,
} from "../runtime-profile/types.js";

export type MonitoringProviderId =
  | "OTEL_COLLECTOR"
  | "SPLUNK_HEC"
  | "PROMETHEUS"
  | "GRAFANA"
  | "GRAFANA_LOKI"
  | "GRAFANA_TEMPO"
  | "GRAFANA_MIMIR"
  | "OPENSEARCH"
  | "ELASTIC"
  | "VICTORIAMETRICS"
  | "ZABBIX";

export type MonitoringRole =
  | "TRANSPORT"
  | "METRICS"
  | "LOGS"
  | "TRACES"
  | "VISUALIZATION"
  | "ALERTING"
  | "SEARCH"
  | "INFRASTRUCTURE";

export type MonitoringDeployment =
  | "LOCAL"
  | "SOVEREIGN_DOMAIN"
  | "EXTERNAL";

export type MonitoringProviderDefinition = {
  id: MonitoringProviderId;
  roles: MonitoringRole[];
  privateCapable: true;
  supportsDisconnected: boolean;
  directEventExport: boolean;
  notes: string;
};

export type MonitoringBinding = {
  provider: MonitoringProviderId;
  deployment: MonitoringDeployment;
  endpoint?: string;
  authRef?: string;
};

export type MonitoringValidation = {
  allowed: boolean;
  reasons: string[];
};

export type MonitoringRequest = {
  provider:
    | "OTEL_COLLECTOR"
    | "SPLUNK_HEC";
  endpoint: string;
  headers: Record<
    string,
    string
  >;
  body: string;
  event: OperationalEvent;
  runtimeProfile:
    RuntimeProfileId;
};

export type MonitoringTransportResult = {
  ok: boolean;
  status: number;
};

export type MonitoringTransport = (
  request: MonitoringRequest,
) => Promise<MonitoringTransportResult>;
