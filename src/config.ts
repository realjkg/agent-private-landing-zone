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
