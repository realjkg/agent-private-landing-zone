/**
 * Capability negotiation for the AI Studio MCP gateway's early AWS pilot.
 * This is NOT an apply endpoint. A decision of PILOT_ELIGIBLE means the
 * existing human-authorized CLI/UI driver may be used after its independent
 * contract, engine, identity, qualification, artifact, and approval gates pass.
 */
export type PilotEngine = "TERRAFORM" | "CDK" | "CLOUDFORMATION" | "PULUMI";
export type ExecutionDecision =
  | { status: "PILOT_ELIGIBLE"; route: "HUMAN_PILOT_DRIVER"; reasons: string[] }
  | { status: "BLOCKED"; route: "NONE"; reasons: string[] };

export type ExecutionRequest = {
  provider: "AWS";
  engine: PilotEngine;
  environment: "DEV" | "QA" | "PROD";
  caller: "AI_STUDIO_AGENT" | "OPERATOR";
  targetClass: "INTERNAL_PILOT" | "CUSTOMER";
  operation: "PREVIEW" | "APPLY";
  /** Existing AWS organization/governance estate is customer-authoritative. */
  governance: "EXISTING_CONTROL_TOWER" | "EXISTING_ORGANIZATIONS" | "UNVERIFIED";
  /** Explicit resource-level changes requested by the workflow. */
  resourceActions: Array<{ resourceType: string; action: "CREATE" | "UPDATE" | "DELETE" | "IMPORT" | "READ" }>;
  pilotContractPinned: boolean;
  engineQualified: boolean;
  targetIdentityVerified: boolean;
  sealedArtifactVerified: boolean;
  signedApprovalsVerified: boolean;
};

export function assessEarlyAwsExecution(input: ExecutionRequest): ExecutionDecision {
  const reasons: string[] = [];
  if (input.governance === "UNVERIFIED") reasons.push("GOVERNANCE_BASELINE_UNVERIFIED");
  if (!Array.isArray(input.resourceActions)) reasons.push("RESOURCE_ACTIONS_REQUIRED");
  else for (const item of input.resourceActions) {
    const type = String(item?.resourceType ?? "").toLowerCase();
    if (!type || !["CREATE", "UPDATE", "DELETE", "IMPORT", "READ"].includes(item.action)) {
      reasons.push("RESOURCE_ACTION_INVALID");
      continue;
    }
    // Reuse existing Control Tower/Organizations APIs and guardrails. Creating
    // a second governance estate is categorically outside this accelerator.
    const landingZone = /(?:controltower|control_tower|control-tower).*(?:landingzone|landing_zone)|aws::controltower::landingzone|aws_organizations_organization|aws::organizations::organization/.test(type);
    const governanceResource = /controltower|control_tower|control-tower|aws::organizations::|aws_organizations_/.test(type);
    if (landingZone && item.action === "CREATE")
      reasons.push("PARALLEL_GOVERNANCE_DEPLOYMENT_FORBIDDEN");
    else if (governanceResource && item.action !== "READ")
      reasons.push("GOVERNANCE_CHANGE_REQUIRES_SEPARATE_AUTHORITY");
    if (input.operation === "APPLY" && !["CREATE", "READ"].includes(item.action))
      reasons.push("EARLY_EXECUTION_ADDITIVE_ONLY");
  }
  if (input.operation === "APPLY" && (!input.resourceActions?.some(x => x.action === "CREATE")))
    reasons.push("ADDITIVE_RESOURCE_REQUIRED");
  if (input.operation === "APPLY" && input.caller !== "OPERATOR")
    reasons.push("AGENT_CANNOT_EXECUTE_APPLY");
  if (input.targetClass !== "INTERNAL_PILOT")
    reasons.push("CUSTOMER_TARGET_EXCLUDED");
  if (input.operation === "APPLY" && input.environment !== "DEV")
    reasons.push("EARLY_EXECUTION_DEV_ONLY");
  if (input.operation === "APPLY" && !["TERRAFORM", "CDK"].includes(input.engine))
    reasons.push("APPLY_ENGINE_NOT_IN_PILOT_CONTRACT");
  if (input.operation === "APPLY") {
    if (!input.pilotContractPinned) reasons.push("PILOT_CONTRACT_NOT_PINNED");
    if (!input.engineQualified) reasons.push("ENGINE_NOT_QUALIFIED");
    if (!input.targetIdentityVerified) reasons.push("TARGET_IDENTITY_NOT_VERIFIED");
    if (!input.sealedArtifactVerified) reasons.push("SEALED_ARTIFACT_NOT_VERIFIED");
    if (!input.signedApprovalsVerified) reasons.push("APPROVALS_NOT_VERIFIED");
  }
  return reasons.length
    ? { status: "BLOCKED", route: "NONE", reasons }
    : { status: "PILOT_ELIGIBLE", route: "HUMAN_PILOT_DRIVER", reasons: [] };
}
