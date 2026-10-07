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
    model: "qwen3:8b",
    role: "ALTERNATE",
    required: false,
    notes:
      "Larger Qwen3 option for higher-capacity private reasoning tests.",
  },
];

export function requiredModels(): ModelDefinition[] {
  return MODEL_CATALOG.filter(
    (model) => model.required,
  );
}
