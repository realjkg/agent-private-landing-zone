import {
  healthSnapshot,
} from "../observability/health.js";
import {
  startObservabilityRuntime,
  type ObservabilityRuntime,
} from "../observability/runtime.js";

/**
 * Human-readable one-shot report: health snapshot, readiness checks (the
 * production-contract observability verdict folded in), and the effective
 * configuration echo. Pure over the runtime so tests can assert on lines.
 */
export function healthReport(
  runtime: ObservabilityRuntime,
): { ready: boolean; lines: string[] } {
  const snapshot = runtime.readiness();
  const evidence = runtime.evidence();
  const config = runtime.config;
  const lines: string[] = [];

  const health = healthSnapshot();

  lines.push("Agent Private Landing Zone — health");
  lines.push(
    "health: " +
      (health.healthy ? "OK" : "UNHEALTHY") +
      " (operating mode " +
      health.operatingMode +
      ", ACT " +
      (health.actEnabled ? "ENABLED" : "DISABLED") +
      ")",
  );
  lines.push(
    "readiness: " + (snapshot.ready ? "READY" : "NOT READY"),
  );

  for (const check of snapshot.checks) {
    lines.push(
      "  " +
        (check.ready ? "✓" : "✗") +
        " " +
        check.name +
        " — " +
        check.detail,
    );
  }

  lines.push("config:");
  lines.push(
    "  structured events: " +
      (config.eventsEnabled
        ? "on (stdout JSON lines)"
        : "OFF — required by the production contract"),
  );
  lines.push(
    "  health server: " +
      (evidence.healthEndpointServing === true
        ? (runtime.healthAddress ?? "serving")
        : config.healthPort !== undefined
          ? "port " + config.healthPort + " when serving (one-shot mode does not serve)"
          : "ephemeral loopback port when serving (one-shot mode does not serve)"),
  );
  lines.push(
    "  monitoring export: " +
      (config.monitoringBinding
        ? config.monitoringBinding.provider +
          " → " +
          config.monitoringBinding.endpoint +
          (config.monitoringBinding.authRef ? " (auth via opaque reference)" : "")
        : "not configured (opt-in)"),
  );

  return { ready: snapshot.ready, lines };
}

const args = process.argv.slice(2);
const serve = args.includes("--serve");

try {
  if (serve) {
    const runtime =
      await startObservabilityRuntime({
        serve: true,
      });

    if (!runtime.health) {
      console.error(
        "Health server is not serving; see the diagnostics line above.",
      );
      process.exitCode = 1;
    } else {
      for (const line of healthReport(runtime).lines) {
        console.log(line);
      }
      console.log(
        "Serving on " +
          runtime.healthAddress +
          " (loopback-only /healthz /readyz /metrics). Ctrl+C stops.",
      );

      process.once("SIGINT", () => {
        void runtime
          .close()
          .finally(() => process.exit(0));
      });
      // The listening server keeps the event loop alive.
    }
  } else {
    const runtime =
      await startObservabilityRuntime();

    const report = healthReport(runtime);

    for (const line of report.lines) {
      console.log(line);
    }

    process.exitCode = report.ready ? 0 : 1;
  }
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "Health command failed.",
  );
  process.exitCode = 1;
}
