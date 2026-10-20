import { classifyAwsResource, type GovernanceEvidence, type ResourceIntent } from "./aws-governance.js";

/**
 * Resource-delta classification from trusted, engine-native plans.
 * A generated agent request is never sufficient proof of the actual change set.
 * Parsers deliberately refuse unknown shapes/actions rather than silently
 * treating an unrecognized action as read-only or safe.
 */
export type NativeEngine = "TERRAFORM" | "CLOUDFORMATION" | "CDK" | "PULUMI";
export type NativePlan = { engine: NativeEngine; payload: unknown };
export type PlanFinding = { address: string; resourceType: string; action: ResourceIntent["action"]; verdict: ReturnType<typeof classifyAwsResource>["verdict"]; reason: string };
export type PlanAssessment = { allowed: boolean; findings: PlanFinding[]; reasons: string[] };

function object(x: unknown): Record<string, unknown> {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error("PLAN_OBJECT_REQUIRED");
  return x as Record<string, unknown>;
}
function array(x: unknown): unknown[] {
  if (!Array.isArray(x)) throw new Error("PLAN_ARRAY_REQUIRED");
  return x;
}
function string(x: unknown): string {
  if (typeof x !== "string" || !x || x.length > 256) throw new Error("PLAN_STRING_INVALID");
  return x;
}
const ACTIONS = new Set(["CREATE","UPDATE","DELETE","IMPORT","READ"]);
function action(raw: unknown): ResourceIntent["action"] {
  const a = String(raw ?? "").toUpperCase();
  if (!ACTIONS.has(a)) throw new Error("PLAN_ACTION_UNSUPPORTED");
  return a as ResourceIntent["action"];
}
function terraformAction(actions: unknown): ResourceIntent["action"] | null {
  const seq = array(actions);
  if (!seq.length || seq.some(a => typeof a !== "string")) throw new Error("TERRAFORM_ACTION_INVALID");
  const key=seq.join(",");
  switch (key) {
    case "no-op": return null;
    case "read": return "READ";
    case "create": return "CREATE";
    case "update": return "UPDATE";
    case "delete": return "DELETE";
    case "delete,create": case "create,delete": return "UPDATE";
    default: throw new Error("TERRAFORM_ACTION_UNSUPPORTED");
  }
}
function extractNative(plan: NativePlan): ResourceIntent[] {
  const p=object(plan.payload);
  if (plan.engine === "TERRAFORM") {
    const changes=array(p.resource_changes);
    return changes.flatMap(change => {
      const row=object(change); const c=object(row.change);
      const kind=terraformAction(c.actions);
      if (kind===null) return [];
      // Terraform provider can surface imported resources without CREATE.
      const operation = c.importing !== undefined ? "IMPORT" : kind;
      return [{ resourceType:string(row.type),action:operation }];
    });
  }
  if (plan.engine === "CLOUDFORMATION" || plan.engine === "CDK") {
    // DescribeChangeSet output, not a template that may contain conditions.
    const changes=array(p.Changes);
    return changes.map(change => {
      const rc=object(object(change).ResourceChange);
      const kind=String(rc.Action);
      const mapped=kind==="Add"?"CREATE":kind==="Modify"?"UPDATE":kind==="Remove"?"DELETE":kind==="Import"?"IMPORT":undefined;
      if (!mapped) throw new Error("CLOUDFORMATION_ACTION_UNSUPPORTED");
      return { resourceType:string(rc.ResourceType),action:action(mapped) };
    });
  }
  if (plan.engine === "PULUMI") {
    // A normalized Pulumi preview envelope produced by our trusted adapter.
    // Refuse arbitrary third-party preview output that lacks explicit steps.
    const steps=array(p.steps);
    return steps.map(x => {
      const step=object(x);
      const op=String(step.op);
      const mapped: Record<string,string>={create:"CREATE",update:"UPDATE",delete:"DELETE",replace:"UPDATE",import:"IMPORT",read:"READ"};
      if (!mapped[op]) throw new Error("PULUMI_ACTION_UNSUPPORTED");
      return {resourceType:string(step.type),action:action(mapped[op])};
    });
  }
  throw new Error("ENGINE_UNSUPPORTED");
}
export function assessNativeAwsPlan(plan: NativePlan, evidence: GovernanceEvidence): PlanAssessment {
  try {
    const intents=extractNative(plan);
    if (!intents.length) return { allowed:false,findings:[],reasons:["PLAN_HAS_NO_RESOURCE_DELTA"] };
    if (intents.length>5000) return { allowed:false,findings:[],reasons:["PLAN_RESOURCE_LIMIT"] };
    const findings=intents.map((item,i)=>{
      const classification=classifyAwsResource(item,evidence);
      return { address: String(i), resourceType:item.resourceType, action:item.action,
        verdict:classification.verdict, reason:classification.reason };
    });
    const reasons=[...new Set(findings.filter(x=>!["APPLICATION_CHANGE","REUSE"].includes(x.verdict))
      .map(x=>x.verdict==="BOOTSTRAP_APPROVAL_REQUIRED"?"FIRST_TIME_GOVERNANCE_BOOTSTRAP_REQUIRES_SEPARATE_AUTHORITY":x.verdict))];
    return { allowed:reasons.length===0,findings,reasons };
  } catch(error) {
    return {allowed:false,findings:[],reasons:["NATIVE_PLAN_INVALID:"+((error as Error).message)]};
  }
}
