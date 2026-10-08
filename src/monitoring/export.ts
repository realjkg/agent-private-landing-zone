import {
  serializeOperationalEvent,
  type OperationalEvent,
} from "../observability/events.js";
import type {
  RuntimeProfileId,
} from "../runtime-profile/types.js";
import {
  monitoringProvider,
} from "./catalog.js";
import type {
  MonitoringBinding,
  MonitoringRequest,
  MonitoringTransport,
  MonitoringTransportResult,
} from "./types.js";
import {
  validateMonitoringBinding,
} from "./validate.js";

function normalizedEvent(
  event: OperationalEvent,
): OperationalEvent {
  return JSON.parse(
    serializeOperationalEvent(
      event,
    ),
  ) as OperationalEvent;
}

function otlpBody(
  event: OperationalEvent,
): string {
  const normalized =
    normalizedEvent(event);
  const timeUnixNano =
    (
      BigInt(
        Date.parse(
          normalized.at,
        ),
      ) * 1_000_000n
    ).toString();

  return JSON.stringify({
    resourceLogs: [
      {
        resource: {
          attributes: [
            {
              key:
                "service.name",
              value: {
                stringValue:
                  "agent-private-landing-zone",
              },
            },
          ],
        },
        scopeLogs: [
          {
            scope: {
              name:
                "alz.monitoring",
            },
            logRecords: [
              {
                timeUnixNano,
                severityText:
                  normalized.status,
                body: {
                  stringValue:
                    JSON.stringify(
                      normalized,
                    ),
                },
                attributes: [
                  {
                    key:
                      "alz.signal",
                    value: {
                      stringValue:
                        normalized.signal,
                    },
                  },
                  {
                    key:
                      "alz.component",
                    value: {
                      stringValue:
                        normalized.component,
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
}

function splunkBody(
  event: OperationalEvent,
): string {
  const normalized =
    normalizedEvent(event);

  return JSON.stringify({
    time:
      Date.parse(normalized.at) /
      1000,
    host:
      "agent-private-landing-zone",
    sourcetype:
      "alz:operational",
    event: normalized,
    fields: {
      signal:
        normalized.signal,
      status:
        normalized.status,
      component:
        normalized.component,
    },
  });
}

export function buildMonitoringRequest(
  profileId: RuntimeProfileId,
  binding: MonitoringBinding,
  event: OperationalEvent,
): MonitoringRequest {
  const validation =
    validateMonitoringBinding(
      profileId,
      binding,
    );

  if (!validation.allowed) {
    throw new Error(
      "MONITORING_BINDING_DENIED: " +
        validation.reasons.join(
          " ",
        ),
    );
  }

  const provider =
    monitoringProvider(
      binding.provider,
    );

  if (
    !provider.directEventExport ||
    (
      binding.provider !==
        "OTEL_COLLECTOR" &&
      binding.provider !==
        "SPLUNK_HEC"
    )
  ) {
    throw new Error(
      "MONITORING_DIRECT_EXPORT_UNSUPPORTED: " +
        binding.provider,
    );
  }

  const endpoint =
    binding.endpoint as string;

  return {
    provider:
      binding.provider,
    endpoint,
    headers: {
      "content-type":
        "application/json",
    },
    ...(binding.authRef
      ? {
          authRef:
            binding.authRef,
        }
      : {}),
    body:
      binding.provider ===
        "OTEL_COLLECTOR"
        ? otlpBody(event)
        : splunkBody(event),
    event:
      normalizedEvent(event),
    runtimeProfile:
      profileId,
  };
}

export async function exportOperationalEvent(
  profileId: RuntimeProfileId,
  binding: MonitoringBinding,
  event: OperationalEvent,
  transport: MonitoringTransport,
): Promise<MonitoringTransportResult> {
  const request =
    buildMonitoringRequest(
      profileId,
      binding,
      event,
    );
  const result =
    await transport(request);

  if (!result.ok) {
    throw new Error(
      "MONITORING_EXPORT_FAILED: " +
        binding.provider +
        " returned " +
        result.status,
    );
  }

  return result;
}

function labelValue(
  value: string,
): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n");
}

export function renderPrometheusEvent(
  event: OperationalEvent,
): string {
  const normalized =
    normalizedEvent(event);
  const labels = [
    'signal="' +
      labelValue(
        normalized.signal,
      ) +
      '"',
    'status="' +
      labelValue(
        normalized.status,
      ) +
      '"',
    'component="' +
      labelValue(
        normalized.component,
      ) +
      '"',
  ].join(",");

  const lines = [
    "# HELP alz_operational_event_total Sovereign Landing Zone operational events.",
    "# TYPE alz_operational_event_total counter",
    "alz_operational_event_total{" +
      labels +
      "} 1",
  ];

  if (
    normalized.durationMs !==
    undefined
  ) {
    lines.push(
      "# HELP alz_operational_event_duration_milliseconds Duration of a Sovereign Landing Zone operational event.",
      "# TYPE alz_operational_event_duration_milliseconds gauge",
      "alz_operational_event_duration_milliseconds{" +
        labels +
        "} " +
        normalized.durationMs,
    );
  }

  return lines.join("\n") +
    "\n";
}
