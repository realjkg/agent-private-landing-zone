import type {
  MonitoringDeployment,
} from "./monitoring/types.js";
import { opaqueSecretRef } from "./monitoring/validate.js";

export type ModelConfig = {
  ollamaBaseUrl: string;
  routerModel: string;
  primaryModel: string;
  validatorModel: string;
  disagreementThreshold: number;
};

export function loadConfig(): ModelConfig {
  return {
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
    routerModel: process.env.ROUTER_MODEL ?? "qwen3:1.7b",
    primaryModel: process.env.PRIMARY_MODEL ?? "qwen3:4b",
    validatorModel: process.env.VALIDATOR_MODEL ?? "mistral-nemo:latest",
    disagreementThreshold: Number(process.env.DISAGREEMENT_THRESHOLD ?? "0.35"),
  };
}

/**
 * Observability configuration surface (spec art_j8hUHQCs section 2).
 *
 * The default posture is on: structured operational events flow to stdout as
 * JSON lines with no configuration at all. Export is opt-in; the loader only
 * parses structurally — profile sovereignty is enforced separately, at the
 * bus export gate, through validateMonitoringBinding (fail-closed).
 */
export type ObservabilityMonitoringProviderConfig =
  | "OTEL_COLLECTOR"
  | "SPLUNK_HEC";

export type ObservabilityMonitoringBindingConfig = {
  provider: ObservabilityMonitoringProviderConfig;
  deployment: MonitoringDeployment;
  endpoint: string;
  authRef?: string;
};

export type ObservabilityConfig = {
  eventsEnabled: boolean;
  healthHost: "127.0.0.1";
  healthPort?: number;
  monitoringBinding?: ObservabilityMonitoringBindingConfig;
};

const LOOPBACK_HEALTH_HOST = "127.0.0.1";

const MONITORING_BINDING_ENV_VARS = [
  "ALZ_MONITORING_PROVIDER",
  "ALZ_MONITORING_DEPLOYMENT",
  "ALZ_MONITORING_ENDPOINT",
  "ALZ_MONITORING_AUTH_REF",
] as const;

function isSet(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

function echoEnv(value: string | undefined): string {
  return value === undefined ? "(unset)" : JSON.stringify(value);
}

function observabilityConfigWarn(line: string): void {
  try {
    process.stderr.write(line + "\n");
  } catch {
    // The diagnostics channel is the last resort; it must not throw either.
  }
}

export function loadObservabilityConfig(
  env: NodeJS.ProcessEnv = process.env,
  warn: (line: string) => void = observabilityConfigWarn,
): ObservabilityConfig {
  const eventsEnabled = parseEventsEnabled(env, warn);
  const healthPort = parseHealthPort(env, warn);
  const monitoringBinding = parseMonitoringBinding(env, warn);

  // Loopback-only is a locked sovereignty decision: a conflicting value is
  // refused, never honored.
  if (isSet(env.ALZ_HEALTH_HOST) && env.ALZ_HEALTH_HOST !== LOOPBACK_HEALTH_HOST) {
    warn(
      "[warn] OBSERVABILITY_CONFIG_INVALID: ALZ_HEALTH_HOST=" +
        echoEnv(env.ALZ_HEALTH_HOST) +
        " is refused; the health server binds loopback (127.0.0.1) only.",
    );
  }

  return {
    eventsEnabled,
    healthHost: LOOPBACK_HEALTH_HOST,
    ...(healthPort !== undefined ? { healthPort } : {}),
    ...(monitoringBinding !== undefined ? { monitoringBinding } : {}),
  };
}

function parseEventsEnabled(
  env: NodeJS.ProcessEnv,
  warn: (line: string) => void,
): boolean {
  const raw = env.ALZ_OBSERVABILITY_EVENTS;

  if (!isSet(raw)) {
    return true;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }

  // Fail toward the default posture: structured events stay on.
  warn(
    "[warn] OBSERVABILITY_CONFIG_INVALID: ALZ_OBSERVABILITY_EVENTS=" +
      echoEnv(raw) +
      " is not true/false; defaulting to true.",
  );
  return true;
}

function parseHealthPort(
  env: NodeJS.ProcessEnv,
  warn: (line: string) => void,
): number | undefined {
  const raw = env.ALZ_HEALTH_PORT;

  if (!isSet(raw)) {
    return undefined;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    warn(
      "[warn] OBSERVABILITY_CONFIG_INVALID: ALZ_HEALTH_PORT=" +
        echoEnv(raw) +
        " is not a valid TCP port; ignoring.",
    );
    return undefined;
  }

  return parsed;
}

function parseMonitoringProvider(
  raw: string | undefined,
  reasons: string[],
): ObservabilityMonitoringProviderConfig | undefined {
  if (raw === "OTEL_COLLECTOR" || raw === "SPLUNK_HEC") {
    return raw;
  }

  reasons.push(
    "ALZ_MONITORING_PROVIDER must be OTEL_COLLECTOR or SPLUNK_HEC (got " +
      echoEnv(raw) +
      "); only direct-event-export providers are configurable.",
  );
  return undefined;
}

function parseMonitoringDeployment(
  raw: string | undefined,
  reasons: string[],
): MonitoringDeployment | undefined {
  if (raw === "LOCAL" || raw === "SOVEREIGN_DOMAIN" || raw === "EXTERNAL") {
    return raw;
  }

  reasons.push(
    "ALZ_MONITORING_DEPLOYMENT must be LOCAL, SOVEREIGN_DOMAIN or EXTERNAL (got " +
      echoEnv(raw) +
      ").",
  );
  return undefined;
}

function parseMonitoringBinding(
  env: NodeJS.ProcessEnv,
  warn: (line: string) => void,
): ObservabilityMonitoringBindingConfig | undefined {
  const providerRaw = env.ALZ_MONITORING_PROVIDER;
  const deploymentRaw = env.ALZ_MONITORING_DEPLOYMENT;
  const endpointRaw = env.ALZ_MONITORING_ENDPOINT;
  const authRefRaw = env.ALZ_MONITORING_AUTH_REF;

  const anySet = MONITORING_BINDING_ENV_VARS.some((name) =>
    isSet(env[name]),
  );
  if (!anySet) {
    return undefined;
  }

  const reasons: string[] = [];
  const provider = parseMonitoringProvider(providerRaw, reasons);
  const deployment = parseMonitoringDeployment(deploymentRaw, reasons);

  const endpoint = isSet(endpointRaw) ? endpointRaw : undefined;
  if (endpoint === undefined) {
    reasons.push(
      "ALZ_MONITORING_ENDPOINT is required: both configurable providers export events directly.",
    );
  }

  const authRef = isSet(authRefRaw) ? authRefRaw : undefined;
  if (authRef !== undefined && !opaqueSecretRef(authRef)) {
    reasons.push(
      "ALZ_MONITORING_AUTH_REF must be an opaque secret://, vault:// or keyring:// reference; raw credentials are refused.",
    );
  }

  if (
    reasons.length > 0 ||
    provider === undefined ||
    deployment === undefined ||
    endpoint === undefined
  ) {
    // Fail closed: drop the binding (export stays off), keep the default-on
    // event stream, and explain once.
    warn(
      "[warn] OBSERVABILITY_CONFIG_INVALID: monitoring export binding disabled — " +
        reasons.join(" "),
    );
    return undefined;
  }

  return {
    provider,
    deployment,
    endpoint,
    ...(authRef !== undefined ? { authRef } : {}),
  };
}
