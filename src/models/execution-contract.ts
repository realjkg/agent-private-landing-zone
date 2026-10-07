export type ModelReasoningRole =
  | "ROUTER"
  | "PRIMARY_ENGINEER"
  | "VALIDATOR"
  | "SPECIALIST";

export type InferenceSubstrate =
  | "OLLAMA_LOCAL"
  | "NVIDIA_NIM_PRIVATE"
  | "FOUNDRY_LOCAL"
  | "BASETEN_SELF_HOSTED"
  | "EXTERNAL_MANAGED";

export type InferenceSubstrateDefinition = {
  id: InferenceSubstrate;
  customerControlledExecution: boolean;
  externalEgressRequired: boolean;
};

export const INFERENCE_SUBSTRATES:
  Record<
    InferenceSubstrate,
    InferenceSubstrateDefinition
  > = {
    OLLAMA_LOCAL: {
      id: "OLLAMA_LOCAL",
      customerControlledExecution: true,
      externalEgressRequired: false,
    },
    NVIDIA_NIM_PRIVATE: {
      id: "NVIDIA_NIM_PRIVATE",
      customerControlledExecution: true,
      externalEgressRequired: false,
    },
    FOUNDRY_LOCAL: {
      id: "FOUNDRY_LOCAL",
      customerControlledExecution: true,
      externalEgressRequired: false,
    },
    BASETEN_SELF_HOSTED: {
      id: "BASETEN_SELF_HOSTED",
      customerControlledExecution: true,
      externalEgressRequired: false,
    },
    EXTERNAL_MANAGED: {
      id: "EXTERNAL_MANAGED",
      customerControlledExecution: false,
      externalEgressRequired: true,
    },
  };

export type SovereignModelAuthority = {
  advisoryOnly: true;
  directToolAccess: false;
  directAdapterAccess: false;
  canGrantCapabilities: false;
  canAlterPolicy: false;
  canAlterDataBoundary: false;
  canAlterEgressPolicy: false;
  canApproveOwnRestrictedAction: false;
  actEnabled: false;
};

export const SOVEREIGN_MODEL_AUTHORITY:
  SovereignModelAuthority = {
    advisoryOnly: true,
    directToolAccess: false,
    directAdapterAccess: false,
    canGrantCapabilities: false,
    canAlterPolicy: false,
    canAlterDataBoundary: false,
    canAlterEgressPolicy: false,
    canApproveOwnRestrictedAction: false,
    actEnabled: false,
  };

export function substrateAllowedByDefault(
  substrate: InferenceSubstrate,
): boolean {
  return (
    INFERENCE_SUBSTRATES[
      substrate
    ].customerControlledExecution &&
    !INFERENCE_SUBSTRATES[
      substrate
    ].externalEgressRequired
  );
}
