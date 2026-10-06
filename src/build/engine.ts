import type {
  IaCEngine,
} from "./types.js";

const aliases: Record<string, IaCEngine> = {
  terraform: "TERRAFORM",
  pulumi: "PULUMI",
  opentofu: "OPENTOFU",
  tofu: "OPENTOFU",
  bicep: "BICEP",
  cloudformation: "CLOUDFORMATION",
  cfn: "CLOUDFORMATION",
  cdk: "AWS_CDK",
  "aws-cdk": "AWS_CDK",
  crossplane: "CROSSPLANE",
  ansible: "ANSIBLE",
};

export const buildEngineNames = [
  "terraform",
  "pulumi",
  "opentofu",
  "bicep",
  "cloudformation",
  "cdk",
  "crossplane",
  "ansible",
] as const;

export function parseBuildEngine(
  value?: string,
): IaCEngine {
  const engine =
    aliases[
      (value ?? "terraform")
        .trim()
        .toLowerCase()
    ];

  if (!engine) {
    throw new Error(
      "Use --engine " +
        buildEngineNames.join(", ") +
        ".",
    );
  }

  return engine;
}
