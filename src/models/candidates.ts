import type {
  InferenceSubstrate,
  ModelReasoningRole,
} from "./execution-contract.js";

export type LaptopFit =
  | "FIT"
  | "TIGHT"
  | "NO";

export type CandidateModel = {
  id: string;
  runtimeModel?: string;
  family: string;
  roles: ModelReasoningRole[];
  substrates: InferenceSubstrate[];
  approximateLocalWeightGb?: number;
  laptop24Fit: LaptopFit;
  nativeToolUse: boolean;
  structuredOutput: boolean;
  longHorizonAgentic: boolean;
  notes: string;
};

export const CANDIDATE_MODELS:
  CandidateModel[] = [
    {
      id:
        "QWEN3_CODER_30B_A3B",
      runtimeModel:
        "qwen3-coder:30b",
      family: "Qwen",
      roles: [
        "PRIMARY_ENGINEER",
        "SPECIALIST",
      ],
      substrates: [
        "OLLAMA_LOCAL",
        "BASETEN_SELF_HOSTED",
      ],
      approximateLocalWeightGb:
        19,
      laptop24Fit: "FIT",
      nativeToolUse: true,
      structuredOutput: true,
      longHorizonAgentic: true,
      notes:
        "Strong laptop primary-worker candidate; 30B total / 3.3B active and repo-scale coding focus.",
    },
    {
      id:
        "DEVSTRAL_SMALL_2_24B",
      runtimeModel:
        "devstral-small-2",
      family: "Mistral",
      roles: [
        "PRIMARY_ENGINEER",
        "SPECIALIST",
      ],
      substrates: [
        "OLLAMA_LOCAL",
        "BASETEN_SELF_HOSTED",
      ],
      approximateLocalWeightGb:
        15,
      laptop24Fit: "FIT",
      nativeToolUse: true,
      structuredOutput: true,
      longHorizonAgentic: true,
      notes:
        "Strong laptop primary-worker candidate with more memory headroom and explicit software-agent training.",
    },
    {
      id: "GPT_OSS_20B",
      runtimeModel:
        "gpt-oss:20b",
      family: "OpenAI",
      roles: [
        "PRIMARY_ENGINEER",
        "VALIDATOR",
        "SPECIALIST",
      ],
      substrates: [
        "OLLAMA_LOCAL",
        "BASETEN_SELF_HOSTED",
      ],
      approximateLocalWeightGb:
        14,
      laptop24Fit: "FIT",
      nativeToolUse: true,
      structuredOutput: true,
      longHorizonAgentic: true,
      notes:
        "Strong local general reasoning / validation candidate with native function calling and structured outputs.",
    },
    {
      id:
        "NEMOTRON_3_5_LIGHTNING_30B_A3B",
      runtimeModel:
        "nemotron-3.5-lightning:30b",
      family: "NVIDIA",
      roles: [
        "PRIMARY_ENGINEER",
        "SPECIALIST",
      ],
      substrates: [
        "OLLAMA_LOCAL",
        "NVIDIA_NIM_PRIVATE",
        "BASETEN_SELF_HOSTED",
      ],
      approximateLocalWeightGb:
        25,
      laptop24Fit: "TIGHT",
      nativeToolUse: true,
      structuredOutput: true,
      longHorizonAgentic: true,
      notes:
        "Always-on agent candidate; default Q4 exceeds practical 24GB headroom. MLX/NVFP4 variants are near the limit.",
    },
    {
      id:
        "PHI_4_MINI_INSTRUCT",
      family: "Microsoft",
      roles: [
        "ROUTER",
        "SPECIALIST",
      ],
      substrates: [
        "FOUNDRY_LOCAL",
        "OLLAMA_LOCAL",
        "BASETEN_SELF_HOSTED",
      ],
      laptop24Fit: "FIT",
      nativeToolUse: false,
      structuredOutput: true,
      longHorizonAgentic: false,
      notes:
        "Compact instruction/specialist candidate; keep tool selection deterministic outside the model.",
    },
    {
      id:
        "PHI_4_REASONING_14B",
      family: "Microsoft",
      roles: [
        "VALIDATOR",
        "SPECIALIST",
      ],
      substrates: [
        "FOUNDRY_LOCAL",
        "OLLAMA_LOCAL",
        "BASETEN_SELF_HOSTED",
      ],
      laptop24Fit: "FIT",
      nativeToolUse: false,
      structuredOutput: false,
      longHorizonAgentic: false,
      notes:
        "Independent reasoning candidate; best used as a validator rather than autonomous tool-calling worker.",
    },
    {
      id:
        "QWEN3_CODER_NEXT",
      family: "Qwen",
      roles: [
        "PRIMARY_ENGINEER",
      ],
      substrates: [
        "NVIDIA_NIM_PRIVATE",
        "BASETEN_SELF_HOSTED",
      ],
      laptop24Fit: "NO",
      nativeToolUse: true,
      structuredOutput: true,
      longHorizonAgentic: true,
      notes:
        "High-capacity private worker candidate; not a 24GB-laptop target.",
    },
    {
      id:
        "NEMOTRON_3_SUPER",
      family: "NVIDIA",
      roles: [
        "PRIMARY_ENGINEER",
        "VALIDATOR",
      ],
      substrates: [
        "NVIDIA_NIM_PRIVATE",
        "BASETEN_SELF_HOSTED",
      ],
      laptop24Fit: "NO",
      nativeToolUse: true,
      structuredOutput: true,
      longHorizonAgentic: true,
      notes:
        "High-capacity private datacenter/AWS candidate; published deployment requirement is far beyond a 24GB laptop.",
    },
  ];

export function candidatesForRole(
  role: ModelReasoningRole,
  options: {
    laptopMemoryGb?: number;
    requireLocal?: boolean;
  } = {},
): CandidateModel[] {
  return CANDIDATE_MODELS
    .filter((candidate) =>
      candidate.roles.includes(
        role,
      ),
    )
    .filter((candidate) =>
      options.requireLocal
        ? candidate.substrates.includes(
            "OLLAMA_LOCAL",
          ) ||
          candidate.substrates.includes(
            "FOUNDRY_LOCAL",
          )
        : true,
    )
    .filter((candidate) => {
      if (
        options.laptopMemoryGb !==
        24
      ) {
        return true;
      }

      return (
        candidate.laptop24Fit !==
        "NO"
      );
    })
    .sort((left, right) => {
      const fitScore = (
        value: LaptopFit,
      ) =>
        value === "FIT"
          ? 0
          : value === "TIGHT"
            ? 1
            : 2;

      const fit =
        fitScore(
          left.laptop24Fit,
        ) -
        fitScore(
          right.laptop24Fit,
        );

      if (fit !== 0) {
        return fit;
      }

      return (
        (left
          .approximateLocalWeightGb ??
          Number.MAX_SAFE_INTEGER) -
        (right
          .approximateLocalWeightGb ??
          Number.MAX_SAFE_INTEGER)
      );
    });
}
