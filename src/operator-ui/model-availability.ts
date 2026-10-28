import { loadConfig } from "../config.js";
import { checkModelDigest, loadModelDigestPins, type ModelDigestPins } from "../models/digest-pins.js";
import { isLoopbackModelEndpoint } from "../ollama.js";

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
  | "MODELS_NOT_INSTALLED"
  | "MODEL_DIGEST_UNPINNED"
  | "MODEL_DIGEST_MISMATCH";

export type ModelAvailability = {
  status: ModelAvailabilityStatus;
  reason: ModelAvailabilityReason;
  /** Configured model tags the private-model workflows require. */
  required: string[];
  /**
   * Required tags not found in the local inventory; for MODEL_DIGEST_UNPINNED and MODEL_DIGEST_MISMATCH, the installed
   * tags whose digest is not the committed release pin (config/tool-pins.json modelDigests).
   */
  missing: string[];
};

const PROBE_TIMEOUT_MS = 1500;

/** The same loopback rule the model client enforces on every call (src/ollama.ts). */
export { isLoopbackModelEndpoint };

export async function probeLocalModels(options: {
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
  /** The release digest pins; defaults to config/tool-pins.json. */
  pins?: ModelDigestPins;
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
  if (!isLoopbackModelEndpoint(baseUrl)) return result("UNAVAILABLE", "MODEL_ENDPOINT_NOT_LOOPBACK");
  // Never probe anything but a credential-free HTTP loopback endpoint.
  const url = new URL(baseUrl);

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
  if (missing.length > 0) return result("UNAVAILABLE", "MODELS_NOT_INSTALLED", missing);
  // Exact versions: each installed model's manifest digest must equal its committed pin. A pin that is missing (an
  // owner input still open) or a pin file that cannot be read refuses, as a different digest does.
  let pins: ModelDigestPins;
  try {
    pins = options.pins ?? loadModelDigestPins();
  } catch {
    return result("UNAVAILABLE", "MODEL_DIGEST_UNPINNED", required);
  }
  const digestOf = (tag: string) => models.find((entry) => entry.name === tag || entry.model === tag)?.digest;
  const checks = required.map((tag) => checkModelDigest(tag, digestOf(tag), pins));
  const mismatched = checks.filter((check) => !check.ok && check.code === "MODEL_DIGEST_MISMATCH").map((check) => check.model);
  if (mismatched.length > 0) return result("UNAVAILABLE", "MODEL_DIGEST_MISMATCH", mismatched);
  const unpinned = checks.filter((check) => !check.ok).map((check) => check.model);
  if (unpinned.length > 0) return result("UNAVAILABLE", "MODEL_DIGEST_UNPINNED", unpinned);
  return result("AVAILABLE", "READY");
}
