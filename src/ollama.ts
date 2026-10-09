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
