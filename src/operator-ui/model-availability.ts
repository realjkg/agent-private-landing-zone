import { loadConfig } from "../config.js";

/**
 * Local private-model availability for the operator console.
 *
 * Advisory and read-only: the console uses this to explain, before a run,
 * whether the private-model workflows (matrix-live, aws-review) can work on
 * this machine. It grants nothing and gates nothing server-side — POST /run
 * validation is unchanged, and the workflows keep their own fail-closed
 * checks. The probe mirrors those checks (loopback endpoint, live models not
 * disabled, the configured Qwen/Mistral tags installed) so the console never
 * offers a workflow its own preconditions would refuse.
 */
export type ModelAvailabilityStatus = "AVAILABLE" | "UNAVAILABLE";

export type ModelAvailabilityReason =
  | "READY"
  | "LIVE_MODELS_DISABLED"
  | "MODEL_ENDPOINT_NOT_LOOPBACK"
  | "NO_LOCAL_MODEL_SERVER"
  | "MODEL_INVENTORY_UNAVAILABLE"
  | "MODELS_NOT_INSTALLED";

export type ModelAvailability = {
  status: ModelAvailabilityStatus;
  reason: ModelAvailabilityReason;
  /** Configured model tags the private-model workflows require. */
  required: string[];
  /** Required tags not found in the local inventory. */
  missing: string[];
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const PROBE_TIMEOUT_MS = 1500;

export async function probeLocalModels(options: {
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
} = {}): Promise<ModelAvailability> {
  const env = options.env ?? process.env;
  const fetcher = options.fetcher ?? fetch;
  const cfg = loadConfig();
  const baseUrl = env.OLLAMA_BASE_URL ?? cfg.ollamaBaseUrl;
  const required = [
    env.ROUTER_MODEL ?? cfg.routerModel,
    env.PRIMARY_MODEL ?? cfg.primaryModel,
    env.VALIDATOR_MODEL ?? cfg.validatorModel,
  ];
  const result = (status: ModelAvailabilityStatus, reason: ModelAvailabilityReason,
    missing: string[] = []): ModelAvailability => ({ status, reason, required, missing });

  if (env.AGENT_SKIP_LOCAL_MODEL === "1") return result("UNAVAILABLE", "LIVE_MODELS_DISABLED");
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return result("UNAVAILABLE", "MODEL_ENDPOINT_NOT_LOOPBACK");
  }
  // Never probe anything but a credential-free HTTP loopback endpoint.
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username || url.password) {
    return result("UNAVAILABLE", "MODEL_ENDPOINT_NOT_LOOPBACK");
  }

  let response: Response;
  try {
    response = await fetcher(url.origin + "/api/tags", {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    return result("UNAVAILABLE", "NO_LOCAL_MODEL_SERVER");
  }
  if (!response.ok) return result("UNAVAILABLE", "MODEL_INVENTORY_UNAVAILABLE");
  let models: Array<{ name?: unknown; model?: unknown; digest?: unknown }>;
  try {
    const body = (await response.json()) as { models?: unknown };
    if (!Array.isArray(body.models)) throw new Error("MODEL_INVENTORY_INVALID");
    models = body.models as typeof models;
  } catch {
    return result("UNAVAILABLE", "MODEL_INVENTORY_UNAVAILABLE");
  }
  // Same matching as getLocalModelMetadata: exact tag or its :latest form,
  // with a digest present.
  const installed = (tag: string) => models.some((entry) =>
    typeof entry.digest === "string" && entry.digest.length > 0 &&
    [tag, tag + ":latest"].some((name) => entry.name === name || entry.model === name));
  const missing = required.filter((tag) => !installed(tag));
  return missing.length > 0
    ? result("UNAVAILABLE", "MODELS_NOT_INSTALLED", missing)
    : result("AVAILABLE", "READY");
}
