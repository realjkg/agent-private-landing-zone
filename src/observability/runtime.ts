import { loadObservabilityConfig, type ObservabilityConfig } from "../config.js";
import type { ObservabilityRuntimeEvidence } from "../qualification/production-contract.js";
import { createConfiguredBus, type ObservabilityBus } from "./bus.js";
import { PRODUCTION_SIGNALS } from "./events.js";
import {
  readinessSnapshot,
  startHealthServer,
  type HealthServer,
  type ReadinessCheck,
} from "./health.js";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runtimeWarn(line: string): void {
  try {
    process.stderr.write(line + "\n");
  } catch {
    // The diagnostics channel is the last resort; it must not throw either.
  }
}

/**
 * The observability state of one long-running process: the configured bus
 * every emission site shares, and (when serving) the loopback health server
 * exposing /healthz, /readyz, and /metrics.
 */
export type ObservabilityRuntime = {
  config: ObservabilityConfig;
  bus: ObservabilityBus;
  health?: HealthServer;
  healthAddress?: string;
  /** Current contract evidence; endpoint claims are live server state. */
  evidence(): ObservabilityRuntimeEvidence;
  /** Readiness snapshot with the contract verdict folded in as a check. */
  readiness(): ReturnType<typeof readinessSnapshot>;
  close(): Promise<void>;
};

export type StartObservabilityRuntimeOptions = {
  /**
   * Serve the loopback health/readiness/metrics server. Long-running runtimes
   * (operator web UI, session) pass true; one-shot commands do not, and the
   * endpoint evidence is then "not evaluated" rather than failing.
   */
  serve?: boolean;
  /** Real readiness checks owned by the host runtime, folded into /readyz. */
  readinessChecks?: () => ReadinessCheck[];
  /** Test-only overrides; production callers take the config surface. */
  port?: number;
  warn?: (line: string) => void;
};

/**
 * Boots observability for a runtime: loads the config surface, constructs the
 * configured bus, and — when serving — starts the loopback health server.
 * Fail-safe by construction: a taken ALZ_HEALTH_PORT or a bind refusal warns
 * once and the host runtime keeps serving; it never crashes the product
 * surface. Events stay on (default posture) even when the server cannot bind.
 */
export async function startObservabilityRuntime(
  options: StartObservabilityRuntimeOptions = {},
): Promise<ObservabilityRuntime> {
  const warn = options.warn ?? runtimeWarn;
  const config = loadObservabilityConfig();
  const bus = createConfiguredBus(config);

  let health: HealthServer | undefined;

  if (options.serve === true) {
    try {
      health = await startHealthServer({
        readiness: () => runtime.readiness(),
        metrics: () => bus.metrics(),
        host: config.healthHost,
        ...(options.port !== undefined
          ? { port: options.port }
          : config.healthPort !== undefined
            ? { port: config.healthPort }
            : {}),
      });
    } catch (error) {
      // Exactly one warn line; the health doors stay down but the runtime
      // continues serving its product surface.
      warn(
        "[warn] OBSERVABILITY_HEALTH_SERVER_DISABLED: " +
          describeError(error),
      );
      health = undefined;
    }
  }

  const serving = (): boolean => health?.server.listening === true;

  const runtime: ObservabilityRuntime = {
    config,
    bus,
    ...(health !== undefined
      ? { health, healthAddress: health.address }
      : {}),
    evidence(): ObservabilityRuntimeEvidence {
      return {
        busWired: true,
        structuredLogsActive: config.eventsEnabled,
        // Every event reaches consumers through createOperationalEvent, so
        // redaction holds by construction for anything this bus delivers.
        secretRedactionActive: true,
        signals: PRODUCTION_SIGNALS,
        ...(options.serve === true
          ? {
              healthEndpointServing: serving(),
              readinessEndpointServing: serving(),
              metricsEndpointServing: serving(),
            }
          : {}),
      };
    },
    readiness(): ReturnType<typeof readinessSnapshot> {
      return readinessSnapshot(
        options.readinessChecks?.() ?? [],
        runtime.evidence(),
      );
    },
    async close(): Promise<void> {
      if (health === undefined) {
        return;
      }
      try {
        await health.close();
      } catch {
        // Closing an already-closed server is a no-op for this runtime.
      }
    },
  };

  return runtime;
}
