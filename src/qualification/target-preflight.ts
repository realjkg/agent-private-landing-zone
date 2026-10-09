import { createHash } from "node:crypto";
import { hostname, totalmem } from "node:os";

import { PRODUCTION_OLLAMA_VERSION } from "./model-production.js";

export const REQUIRED_PRIVATE_MODELS = [
  "qwen3:1.7b", "qwen3:4b", "mistral-nemo:latest",
] as const;

export type TargetPreflight = {
  schemaVersion: 1;
  mode: "REAL_LOCAL_RUNTIME_METADATA_ONLY";
  sourceCommit: string;
  targetHardwareId: string;
  runnerName: string;
  hostFingerprint: string;
  platformMemoryBytes: number;
  endpoint: string;
  runtimeVersion: string;
  models: Array<{ name: string; digest: string; size: number }>;
  checks: Array<{ id: string; passed: boolean; detail: string }>;
  passed: boolean;
  actualModelInference: "NOT_RUN";
  actualCloudProviderPreview: "NOT_RUN";
  infrastructureAct: "DISABLED";
};

type Fetcher = typeof fetch;

function sanitizeEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username || url.password || url.search || url.hash ||
    (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("PREFLIGHT_LOOPBACK_ONLY");
  }
  return url.origin;
}

function hexSha(value: string, length: number): boolean {
  return new RegExp("^[a-f0-9]{" + length + "}$", "i").test(value);
}

export async function probeTargetPreflight(input: {
  sourceCommit: string;
  targetHardwareId: string;
  runnerName: string;
  baseUrl: string;
  host?: string;
  memoryBytes?: number;
  skipLocalModel?: boolean;
}, fetcher: Fetcher = fetch): Promise<TargetPreflight> {
  const checks: TargetPreflight["checks"] = [];
  const add = (id: string, passed: boolean, detail: string) => {
    checks.push({ id, passed, detail });
  };
  const hostId = input.host ?? hostname();
  const memoryBytes = input.memoryBytes ?? totalmem();
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ hostId, runnerName: input.runnerName,
      hardware: input.targetHardwareId, memoryBytes }))
    .digest("hex");
  add("source", hexSha(input.sourceCommit, 40), "Exact source commit required");
  add("target", Boolean(input.targetHardwareId.trim()) &&
    input.targetHardwareId !== "UNKNOWN" &&
    Boolean(input.runnerName.trim()) && input.runnerName !== "UNKNOWN",
    "Explicit non-default hardware and runner identities required");
  add("local-inference-enabled", input.skipLocalModel !== true,
    "Fixture/skip-local-model mode must be disabled");

  let endpoint = "INVALID";
  try {
    endpoint = sanitizeEndpoint(input.baseUrl);
    add("endpoint", true, "Loopback-only Ollama API URL");
  } catch {
    add("endpoint", false, "Only HTTP loopback with no credentials/path/query is allowed");
  }
  let runtimeVersion = "NOT_RUN";
  const models: TargetPreflight["models"] = [];
  if (checks.every((item) => item.passed)) {
    try {
      const r = await fetcher(endpoint + "/api/version", {
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw new Error("RUNTIME_NOT_HEALTHY");
      const v = await r.json() as { version?: unknown };
      runtimeVersion = typeof v.version === "string" ? v.version : "UNKNOWN";
      add("pinned-runtime", runtimeVersion === PRODUCTION_OLLAMA_VERSION,
        "Target runtime must report exact Ollama " + PRODUCTION_OLLAMA_VERSION);
    } catch {
      add("pinned-runtime", false, "Local Ollama version probe unavailable");
    }
    if (runtimeVersion === PRODUCTION_OLLAMA_VERSION) {
      try {
        const response = await fetcher(endpoint + "/api/tags", {
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error("MODEL_INVENTORY_UNAVAILABLE");
        const body = await response.json() as {
          models?: Array<{ name?: unknown; model?: unknown;
            digest?: unknown; size?: unknown }>;
        };
        if (!Array.isArray(body.models)) throw new Error("MODEL_INVENTORY_INVALID");
        for (const name of REQUIRED_PRIVATE_MODELS) {
          const matching = body.models.filter((item) =>
            item.name === name || item.model === name);
          const good = matching.length === 1 &&
            typeof matching[0]?.digest === "string" &&
            hexSha(matching[0].digest, 64) &&
            typeof matching[0]?.size === "number" &&
            Number.isFinite(matching[0].size) && matching[0].size > 0;
          add("model:" + name, good, good
            ? "Pinned local model digest and size available"
            : "Model missing, duplicated or missing valid digest");
          if (good) {
            models.push({ name, digest: matching[0].digest as string,
              size: matching[0].size as number });
          }
        }
      } catch {
        add("model-inventory", false, "Local model inventory unavailable/invalid");
      }
    }
  }
  return {
    schemaVersion: 1, mode: "REAL_LOCAL_RUNTIME_METADATA_ONLY",
    sourceCommit: input.sourceCommit,
    targetHardwareId: input.targetHardwareId,
    runnerName: input.runnerName,
    hostFingerprint: fingerprint,
    platformMemoryBytes: memoryBytes,
    endpoint, runtimeVersion, models, checks,
    passed: checks.every((item) => item.passed) &&
      models.length === REQUIRED_PRIVATE_MODELS.length,
    actualModelInference: "NOT_RUN",
    actualCloudProviderPreview: "NOT_RUN",
    infrastructureAct: "DISABLED",
  };
}
