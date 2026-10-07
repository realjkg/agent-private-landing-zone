export type ModelRole =
  | "ROUTER"
  | "PRIMARY"
  | "VALIDATOR"
  | "ALTERNATE";

export type ModelDefinition = {
  model: string;
  role: ModelRole;
  required: boolean;
  notes: string;
};

export const MODEL_CATALOG: ModelDefinition[] = [
  {
    model: "qwen3:1.7b",
    role: "ROUTER",
    required: true,
    notes:
      "Default supervisor and adjudication model.",
  },
  {
    model: "qwen3:4b",
    role: "PRIMARY",
    required: true,
    notes:
      "Default primary engineering model.",
  },
  {
    model: "mistral-nemo:latest",
    role: "VALIDATOR",
    required: true,
    notes:
      "Default independent engineering validator.",
  },
  {
    model: "qwen2.5:3b",
    role: "ALTERNATE",
    required: false,
    notes:
      "Previously named local Qwen option.",
  },
  {
    model: "phi-4-mini",
    role: "ALTERNATE",
    required: false,
    notes:
      "Previously named local Azure-aligned option.",
  },
];

export function requiredModels(): ModelDefinition[] {
  return MODEL_CATALOG.filter(
    (model) => model.required,
  );
}
