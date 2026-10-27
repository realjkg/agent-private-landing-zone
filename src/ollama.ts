export type OllamaMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

import { DISABLED_EMITTER, type Emitter } from "./observability/bus.js";

/**
 * Soft latency threshold for a local chat completion. Below it a call is OK;
 * at or above it the model-latency signal reports DEGRADED (warning alert
 * posture per config/alert-rules.yaml). Timeout still fails the call.
 */
export const MODEL_LATENCY_DEGRADED_MS = 30_000;

export type ModelInvocationOptions = {
  timeoutMs?: number;
  format?: "json" | Record<string, unknown>;
  think?: boolean | string;
  /** Overrides MODEL_LATENCY_DEGRADED_MS for tests. */
  latencyDegradedMs?: number;
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** True only for a credential-free http address on this machine (localhost, 127.0.0.1 or [::1]). */
export function isLoopbackModelEndpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * Private inference only: every call to a model server goes to this machine. A non-loopback OLLAMA_BASE_URL (another
 * host, https to a hosted service, an address with credentials) is refused before any request is made, and nothing
 * falls back to another endpoint. The message names the reason and never echoes the address, which could hold a secret.
 */
export function assertLoopbackModelEndpoint(baseUrl: string): void {
  if (!isLoopbackModelEndpoint(baseUrl)) {
    throw new Error(
      "MODEL_ENDPOINT_NOT_LOOPBACK: BLOCKED. OLLAMA_BASE_URL must be a credential-free http address on this machine " +
        "(localhost, 127.0.0.1 or [::1]). Private inference only: no request was sent and there is no hosted fallback.",
    );
  }
}

export const STRUCTURED_MODEL_OPTIONS =
  Object.freeze({
    format: "json" as const,
    think: false,
  });

export async function invokeLocalModel(
  baseUrl: string,
  model: string,
  messages: OllamaMessage[],
  options: ModelInvocationOptions = {},
  emitter: Emitter = DISABLED_EMITTER,
): Promise<string> {
  // Before the timer, the emitter or any request: a non-loopback endpoint is never contacted.
  assertLoopbackModelEndpoint(baseUrl);
  const timeoutMs = options.timeoutMs ?? 120_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        ...(options.format !== undefined
          ? {
              format: options.format,
            }
          : {}),
        ...(options.think !== undefined
          ? {
              think: options.think,
            }
          : {}),
        options: {
          temperature: 0,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Ollama request failed for ${model}: ${response.status} ${await response.text()}`,
      );
    }

    const body = (await response.json()) as {
      message?: {
        content?: string;
      };
    };

    const content = body.message?.content?.trim();

    if (!content) {
      throw new Error(`Ollama returned an empty response for ${model}`);
    }

    const durationMs = Date.now() - startedAt;
    emitter.emit({
      signal: "model-latency",
      status:
        durationMs >=
        (options.latencyDegradedMs ??
          MODEL_LATENCY_DEGRADED_MS)
          ? "DEGRADED"
          : "OK",
      component: "model-invocation",
      durationMs,
      attributes: { model },
    });

    return content;
  } catch (error) {
    emitter.emit({
      signal: "model-latency",
      status: "FAILED",
      component: "model-invocation",
      durationMs: Date.now() - startedAt,
      detail:
        error instanceof Error
          ? error.message
          : "unknown model failure",
      attributes: { model },
    });

    if (
      error instanceof DOMException &&
      error.name === "AbortError"
    ) {
      throw new Error(
        `MODEL_TIMEOUT: ${model} exceeded ${timeoutMs}ms`,
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export type LocalModelMetadata = {
  model: string;
  digest: string;
  size: number;
  modifiedAt?: string;
};

export async function getLocalModelMetadata(
  baseUrl: string,
  model: string,
): Promise<LocalModelMetadata> {
  assertLoopbackModelEndpoint(baseUrl);
  const response = await fetch(
    `${baseUrl}/api/tags`,
  );

  if (!response.ok) {
    throw new Error(
      `Ollama model inventory failed: ${response.status} ${await response.text()}`,
    );
  }

  const body = (await response.json()) as {
    models?: Array<{
      name?: string;
      model?: string;
      digest?: string;
      size?: number;
      modified_at?: string;
    }>;
  };

  const entry = (body.models ?? []).find(
    (candidate) =>
      candidate.name === model ||
      candidate.model === model ||
      candidate.name === model + ":latest" ||
      candidate.model === model + ":latest",
  );

  if (
    !entry?.digest ||
    typeof entry.size !== "number"
  ) {
    throw new Error(
      "MODEL_NOT_INSTALLED: " + model,
    );
  }

  return {
    model:
      entry.model ??
      entry.name ??
      model,
    digest: entry.digest,
    size: entry.size,
    modifiedAt:
      entry.modified_at,
  };
}
