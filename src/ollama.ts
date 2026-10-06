export type OllamaMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export async function invokeLocalModel(
  baseUrl: string,
  model: string,
  messages: OllamaMessage[],
): Promise<string> {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      options: { temperature: 0 },
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed for ${model}: ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as {
    message?: { content?: string };
  };

  const content = body.message?.content?.trim();
  if (!content) {
    throw new Error(`Ollama returned an empty response for ${model}`);
  }

  return content;
}
