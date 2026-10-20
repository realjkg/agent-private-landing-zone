/**
 * Hosted AI Studio is the agent harness. ALZ is the private deterministic
 * orchestration and policy enforcement substrate. Skills/connectors remain
 * Studio-owned; only declared capabilities cross the MCP boundary.
 */
export type AgentRole = "INVENTORY" | "PLAN" | "DESIGN" | "POLICY" | "IAC" | "VERIFY" | "OPERATE";
export type EngineId = "TERRAFORM" | "PULUMI" | "OPENTOFU" | "BICEP" | "CLOUDFORMATION" | "AWS_CDK" | "ANSIBLE" | "CROSSPLANE";
export type Capability = "DISCOVERY_READ" | "EVIDENCE_READ" | "POLICY_ASSESS" | "IAC_PREVIEW";
export type HarnessRoute = {
  interface: "STUDIO_PRESIDIO_AI";
  transport: "MCP_STREAMABLE_HTTP";
  target: "PRIVATE_ALZ";
  remoteAuthVerified: boolean;
  tokenAudienceVerified: boolean;
  requestIdentity: string;
  correlationId: string;
};
export type AgentTask = {
  role: AgentRole;
  capability: Capability;
  engine?: EngineId;
  blueprintId: string;
  delegatedBy: string;
  traceId: string;
};
export type RouteDecision =
  | { allowed: true; execution: "READ_OR_PREVIEW_ONLY"; route: "PRIVATE_POLICY_BROKER"; role: AgentRole }
  | { allowed: false; reason: string };

const ROLE_CAPABILITIES: Record<AgentRole, readonly Capability[]> = {
  INVENTORY: ["DISCOVERY_READ"],
  PLAN: ["DISCOVERY_READ", "EVIDENCE_READ", "POLICY_ASSESS"],
  DESIGN: ["DISCOVERY_READ", "EVIDENCE_READ", "POLICY_ASSESS", "IAC_PREVIEW"],
  POLICY: ["EVIDENCE_READ", "POLICY_ASSESS"],
  IAC: ["EVIDENCE_READ", "IAC_PREVIEW"],
  VERIFY: ["DISCOVERY_READ", "EVIDENCE_READ", "POLICY_ASSESS"],
  OPERATE: ["DISCOVERY_READ", "EVIDENCE_READ", "POLICY_ASSESS"]
};
const ENGINES = new Set<EngineId>([
  "TERRAFORM","PULUMI","OPENTOFU","BICEP","CLOUDFORMATION","AWS_CDK","ANSIBLE","CROSSPLANE"
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export function routeStudioSubagent(route: HarnessRoute, task: AgentTask): RouteDecision {
  if (route.interface !== "STUDIO_PRESIDIO_AI" || route.transport !== "MCP_STREAMABLE_HTTP" || route.target !== "PRIVATE_ALZ")
    return { allowed:false, reason:"HARNESS_ROUTE_UNSUPPORTED" };
  if (!route.remoteAuthVerified || !route.tokenAudienceVerified)
    return { allowed:false, reason:"HARNESS_AUTH_NOT_VERIFIED" };
  if (![route.requestIdentity,route.correlationId,task.blueprintId,task.delegatedBy,task.traceId].every(x => typeof x === "string" && ID.test(x)))
    return { allowed:false, reason:"HARNESS_IDENTITY_OR_TRACE_INVALID" };
  const grants=ROLE_CAPABILITIES[task.role];
  if (!grants || !grants.includes(task.capability))
    return { allowed:false, reason:"SUBAGENT_CAPABILITY_DENIED" };
  if (task.engine !== undefined && !ENGINES.has(task.engine))
    return { allowed:false, reason:"SUBAGENT_ENGINE_UNKNOWN" };
  if (task.capability === "IAC_PREVIEW" && !task.engine)
    return { allowed:false, reason:"SUBAGENT_ENGINE_REQUIRED" };
  return { allowed:true,execution:"READ_OR_PREVIEW_ONLY",route:"PRIVATE_POLICY_BROKER",role:task.role };
}
/** All eight supported adapters may be part of the base installation profile,
 * but selected tooling is activated only when a blueprint requires it. */
export const BASE_BUILD_ENGINES: readonly EngineId[] = [
  "TERRAFORM","PULUMI","OPENTOFU","BICEP","CLOUDFORMATION","AWS_CDK","ANSIBLE","CROSSPLANE"
];
