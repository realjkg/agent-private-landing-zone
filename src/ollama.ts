export type OllamaMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ModelInvocationOptions = {
  timeoutMs?: number;
};

export async function invokeLocalModel(
  baseUrl: string,
  model: string,
  messages: OllamaMessage[],
  options: ModelInvocationOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

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

    return content;
  } catch (error) {
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
