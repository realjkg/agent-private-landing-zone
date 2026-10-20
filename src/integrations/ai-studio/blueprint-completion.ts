import { sha256 } from "../../util/sha256.js";
import type { BlueprintRelease } from "./blueprint-release.js";

/**
 * Deterministic blueprint completion: required topology, controls and
 * deployment contracts are explicitly reviewed before release eligibility.
 * All data is source material for a later immutable approved blueprint.
 */
export type LandingZoneBlueprint = {
  schemaVersion: 1;
  blueprintId: string;
  provider: "AWS";
  scope: "CONTROL_TOWER_BOOTSTRAP" | "CONTROL_TOWER_REUSE" | "APPLICATION_LANDING_ZONE";
  governance: {
    managementAccountId: string;
    homeRegion: string;
    governedRegions: string[];
    organizationId?: string;
    existingControlTowerLandingZoneArn?: string;
    /** Trustworthy discovery evidence; a model assertion is insufficient. */
    discoveryEvidenceRef: string;
  };
  environments: {
    devAccountId?: string;
    nonProdAccountId?: string;
    productionAccountId?: string;
    /** Planning targets are required before account IDs exist during bootstrap. */
    devAccountAlias: string;
    nonProdAccountAlias: string;
    productionAccountAlias: string;
    separateStateBackends: boolean;
    separateExecutionIdentities: boolean;
  };
  architecture: {
    accountTopology: string;
    networkDesign: string;
    identityDesign: string;
    loggingDesign: string;
    encryptionDesign: string;
    monitoringDesign: string;
    recoveryDesign: string;
  };
  policies: {
    authorityRef: string;
    inheritedPolicies: string[];
    proposedControls: string[];
    compatibilityEvidenceRef: string;
  };
  execution: {
    engine: "TERRAFORM" | "CDK" | "CLOUDFORMATION" | "PULUMI";
    stateOwnershipRef: string;
    validationEvidenceRef: string;
    costEstimateEvidenceRef: string;
    scanEvidenceRef: string;
    rollbackEvidenceRef: string;
  };
};
export type BlueprintCompletion = {
  complete: boolean;
  sha256?: string;
  releaseIdentity?: string;
  missing: string[];
};
const REF=/^evidence:\/\/[a-zA-Z0-9._/-]{1,128}$/;
const SAFE=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const ACCOUNT=/^[0-9]{12}$/;
const REGION=/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;
function isRef(x: unknown): boolean { return typeof x==="string" && REF.test(x) && !x.includes(".."); }
function isText(x: unknown): boolean { return typeof x==="string" && x.trim().length>0 && x.length<=2000; }
function sortedUnique(x: string[]): string[] { return [...new Set(x)].sort(); }
export function completeLandingZoneBlueprint(value: LandingZoneBlueprint): BlueprintCompletion {
  const missing: string[]=[];
  const need=(ok:boolean,path:string)=>{if(!ok)missing.push(path);};
  if(!value || typeof value!=="object")return {complete:false,missing:["blueprint"]};
  need(value.schemaVersion===1,"schemaVersion");
  need(value.provider==="AWS","provider");
  need(typeof value.blueprintId==="string"&&SAFE.test(value.blueprintId),"blueprintId");
  need(["CONTROL_TOWER_BOOTSTRAP","CONTROL_TOWER_REUSE","APPLICATION_LANDING_ZONE"].includes(value.scope),"scope");
  const g=value.governance;
  need(!!g,"governance");
  if(g){
    need(ACCOUNT.test(g.managementAccountId??""),"governance.managementAccountId");
    need(REGION.test(g.homeRegion??""),"governance.homeRegion");
    need(Array.isArray(g.governedRegions)&&g.governedRegions.length>0&&
      g.governedRegions.every(x=>REGION.test(x))&&g.governedRegions.includes(g.homeRegion),"governance.governedRegions");
    need(isRef(g.discoveryEvidenceRef),"governance.discoveryEvidenceRef");
    if(value.scope==="CONTROL_TOWER_REUSE")
      need(isText(g.existingControlTowerLandingZoneArn),"governance.existingControlTowerLandingZoneArn");
    if(value.scope==="CONTROL_TOWER_BOOTSTRAP")
      need(!g.existingControlTowerLandingZoneArn,"governance.bootstrapNoExistingLandingZone");
  }
  const e=value.environments;
  need(!!e,"environments");
  if(e){
    for(const key of ["devAccountAlias","nonProdAccountAlias","productionAccountAlias"] as const)
      need(typeof e[key]==="string" && SAFE.test(e[key]),"environments."+key);
    need(new Set([e.devAccountAlias,e.nonProdAccountAlias,e.productionAccountAlias]).size===3,
      "environments.distinctTargetAliases");
    if(value.scope!=="CONTROL_TOWER_BOOTSTRAP") {
      for(const key of ["devAccountId","nonProdAccountId","productionAccountId"] as const)
        need(ACCOUNT.test(e[key]??""),"environments."+key);
      need(new Set([e.devAccountId,e.nonProdAccountId,e.productionAccountId]).size===3,
        "environments.distinctTargets");
    } else {
      for(const key of ["devAccountId","nonProdAccountId","productionAccountId"] as const)
        need(e[key]===undefined || ACCOUNT.test(e[key]),"environments."+key);
    }
    need(e.separateStateBackends===true,"environments.separateStateBackends");
    need(e.separateExecutionIdentities===true,"environments.separateExecutionIdentities");
  }
  const a=value.architecture;
  need(!!a,"architecture");
  if(a)for(const key of ["accountTopology","networkDesign","identityDesign","loggingDesign",
    "encryptionDesign","monitoringDesign","recoveryDesign"] as const)
    need(isText(a[key]),"architecture."+key);
  const p=value.policies;
  need(!!p,"policies");
  if(p){
    need(isText(p.authorityRef),"policies.authorityRef");
    need(Array.isArray(p.inheritedPolicies)&&p.inheritedPolicies.every(isText),"policies.inheritedPolicies");
    need(Array.isArray(p.proposedControls)&&p.proposedControls.every(isText),"policies.proposedControls");
    need(isRef(p.compatibilityEvidenceRef),"policies.compatibilityEvidenceRef");
  }
  const x=value.execution;
  need(!!x,"execution");
  if(x){
    need(["TERRAFORM","CDK","CLOUDFORMATION","PULUMI"].includes(x.engine),"execution.engine");
    for(const key of ["stateOwnershipRef","validationEvidenceRef","costEstimateEvidenceRef",
      "scanEvidenceRef","rollbackEvidenceRef"] as const)
      need(isRef(x[key]),"execution."+key);
  }
  if(missing.length) return {complete:false,missing};
  // Canonicalize set-like arrays, keeping serialized order deterministic.
  const canonical={
    ...value,
    governance:{...g,governedRegions:sortedUnique(g.governedRegions)},
    policies:{...p,inheritedPolicies:sortedUnique(p.inheritedPolicies),
      proposedControls:sortedUnique(p.proposedControls)}
  };
  const hash=sha256(JSON.stringify(canonical));
  return {complete:true,sha256:hash,releaseIdentity:value.blueprintId};
}
export function blueprintReleaseFromCompleted(
  value: LandingZoneBlueprint
): BlueprintRelease {
  const result=completeLandingZoneBlueprint(value);
  if(!result.complete || !result.sha256 || !result.releaseIdentity)
    throw new Error("BLUEPRINT_INCOMPLETE:"+result.missing.join(","));
  return {state:"COMPLETE",blueprintSha256:result.sha256,releaseIdentity:result.releaseIdentity};
}
