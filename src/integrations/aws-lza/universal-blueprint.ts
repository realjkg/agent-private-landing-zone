import { createHash } from "node:crypto";
import { completeLandingZoneBlueprint, type LandingZoneBlueprint } from "../ai-studio/blueprint-completion.js";
import { inspectLzaConfiguration, type LzaIntakeFile, type LzaIntakeMode } from "./config-intake.js";

/**
 * Review-only compatibility boundary. Structured sections must be supplied by
 * a pinned, version-matched LZA YAML/include parser, never an LLM or raw regex.
 * The validator claim describes source-bound evidence, but cannot prove a
 * signature by itself. Always require independent artifact verification.
 */
export type LzaOfficialValidation = {
  lzaVersion: string;
  universalConfigRevision: string;
  bundleSha256: string;
  validationArtifactSha256: string;
  result: "PASS" | "FAIL";
  source: "OFFICIAL_LZA_VERSION_MATCHED_VALIDATOR";
  independentlyVerified: boolean;
};
export type LzaStructuredSections = {
  global?: {
    homeRegion?: unknown;
    enabledRegions?: unknown;
    managementAccountAccessRole?: unknown;
    controlTower?: { enable?: unknown };
  };
  accounts?: {
    managementAccountId?: unknown;
    mandatoryAccounts?: unknown;
    workloadAccounts?: unknown;
  };
  organization?: {
    organizationalUnits?: unknown;
    serviceControlPolicies?: unknown;
  };
  iam?: { policySets?: unknown };
  network?: { vpcs?: unknown };
  security?: { centralSecurityServices?: unknown };
};
export type LzaExistingAwsTarget = {
  accountId: string;
  region: string;
  organization: "EXISTS" | "ABSENT" | "UNKNOWN";
  controlTower: "EXISTS" | "ABSENT" | "UNKNOWN";
  identity: "OBSERVED" | "UNVERIFIED";
  discoveryArtifactSha256?: string;
  existingAccounts: string[];
  existingVpcNames: string[];
};
export type LzaMappingInput = {
  files: readonly LzaIntakeFile[];
  mode: LzaIntakeMode;
  validation: LzaOfficialValidation;
  sections: LzaStructuredSections;
  /** Exact source-bounded data, independently observed, not model asserted. */
  target: LzaExistingAwsTarget;
  blueprintId: string;
};
export type LzaMappingResult = {
  disposition: "BLOCKED" | "REVIEW_REQUIRED";
  issues: string[];
  intakeSha256?: string;
  officialSchema: "VERIFIED_VERSION_MATCHED" | "NOT_ACCEPTED";
  mapped: {
    blueprintDraft: Partial<LandingZoneBlueprint>;
    regionCandidates: string[];
    existingVpcNames: string[];
    organizationReuse: boolean;
    configurationRevision: string;
  };
  blueprintComplete: false;
  mayApply: false;
  actEnabled: false;
};
const SHA=/^[a-f0-9]{64}$/;
const ACCOUNT=/^[0-9]{12}$/;
const REGION=/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;
const VERSION=/^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/;
const REF=/^[a-f0-9]{7,64}$/;
const NAME=/^[A-Za-z0-9][A-Za-z0-9._:-]{1,95}$/;
const sha=(s:string)=>createHash("sha256").update(s).digest("hex");
const isObj=(x:unknown):x is Record<string,unknown>=>!!x && typeof x==="object" && !Array.isArray(x);
const uniq=(a:string[])=>a.length===new Set(a).size;
function names(x:unknown,field:string,issues:string[]):string[] {
  if(x===undefined)return [];
  if(!Array.isArray(x)){issues.push(field+"_SHAPE_INVALID");return [];}
  const out:string[]=[];
  for(const entry of x) {
    if(!isObj(entry)||typeof entry.name!=="string"||!NAME.test(entry.name)){
      issues.push(field+"_ENTRY_INVALID");continue;
    }
    out.push(entry.name);
  }
  if(!uniq(out))issues.push(field+"_DUPLICATE");
  return out;
}
export function mapLzaUniversalConfiguration(input:LzaMappingInput):LzaMappingResult {
  const issues:string[]=[];
  const intake=inspectLzaConfiguration(input.files,input.mode);
  if(intake.verdict==="REJECTED"||!intake.bundleSha256)issues.push("LZA_INTAKE_REJECTED",...intake.issues);
  const v=input.validation;
  if(!v || v.source!=="OFFICIAL_LZA_VERSION_MATCHED_VALIDATOR" ||
     v.result!=="PASS" || v.independentlyVerified!==true ||
     !VERSION.test(v.lzaVersion??"") || !REF.test(v.universalConfigRevision??"") ||
     !SHA.test(v.validationArtifactSha256??"") ||
     v.bundleSha256!==intake.bundleSha256)issues.push("OFFICIAL_LZA_VALIDATION_UNVERIFIED");
  const s=input.sections;
  if(!isObj(s)||!isObj(s.global)||!isObj(s.accounts)||!isObj(s.organization))
    issues.push("STRUCTURED_SECTIONS_REQUIRED");
  const g=isObj(s?.global)?s.global:{};
  const a=isObj(s?.accounts)?s.accounts:{};
  const o=isObj(s?.organization)?s.organization:{};
  const t=input.target;
  if(!t||!ACCOUNT.test(t.accountId??"")||!REGION.test(t.region??"")||
     t.identity!=="OBSERVED" || !SHA.test(t.discoveryArtifactSha256??""))
    issues.push("TARGET_IDENTITY_UNVERIFIED");
  const home=typeof g.homeRegion==="string"?g.homeRegion:"";
  const regions=Array.isArray(g.enabledRegions) &&
    g.enabledRegions.every(x=>typeof x==="string"&&REGION.test(x))?
    g.enabledRegions as string[]:[];
  if(!REGION.test(home)||regions.length===0||!regions.includes(home)||!uniq(regions))
    issues.push("LZA_REGIONS_INVALID");
  if(t && (t.region!==home || !regions.includes(t.region)))
    issues.push("TARGET_REGION_MISMATCH");
  if(a.managementAccountId!==undefined && a.managementAccountId!==t?.accountId)
    issues.push("LZA_MANAGEMENT_ACCOUNT_MISMATCH");
  const mandatory=names(a.mandatoryAccounts,"MANDATORY_ACCOUNTS",issues);
  const workload=names(a.workloadAccounts,"WORKLOAD_ACCOUNTS",issues);
  const ous=names(o.organizationalUnits,"ORGANIZATIONAL_UNITS",issues);
  const vpcs=names(isObj(s?.network)?s.network.vpcs:undefined,"NETWORK_VPCS",issues);
  if(!NAME.test(input.blueprintId??""))issues.push("BLUEPRINT_ID_INVALID");
  // Reading an Organizations/Control Tower baseline does not authorize
  // account creation, OU creation, network creation or root bootstrap.
  if(g.controlTower?.enable===true)issues.push("CONTROL_TOWER_ENABLE_REQUIRES_SEPARATE_PLAN");
  if(mandatory.length||workload.length)issues.push("ACCOUNT_VENDING_REQUIRES_SEPARATE_PLAN");
  if(ous.length)issues.push("ORGANIZATION_MUTATIONS_REQUIRE_SEPARATE_PLAN");
  if(vpcs.length)issues.push("NETWORK_CREATION_REQUIRES_SEPARATE_PLAN");
  if(t && (t.organization==="UNKNOWN"||t.controlTower==="UNKNOWN"))
    issues.push("GOVERNANCE_DISCOVERY_INCOMPLETE");
  if(t && g.controlTower?.enable===true && t.controlTower==="EXISTS")
    issues.push("PARALLEL_CONTROL_TOWER_FORBIDDEN");
  if(t && vpcs.some(x=>t.existingVpcNames?.includes(x)))
    issues.push("EXISTING_VPC_NAME_COLLISION");
  if(t && !Array.isArray(t.existingAccounts))issues.push("ACCOUNT_INVENTORY_INVALID");
  const mapped: LzaMappingResult["mapped"]={
    blueprintDraft:{
      schemaVersion:1,provider:"AWS",
      ...(NAME.test(input.blueprintId??"")?{blueprintId:input.blueprintId}:{}),
      scope:"APPLICATION_LANDING_ZONE",
      governance:{
        managementAccountId:ACCOUNT.test(t?.accountId??"")?t.accountId:"",
        homeRegion:home,governedRegions:regions,
        discoveryEvidenceRef:"evidence://pending/independent-review"
      }
    },
    regionCandidates:regions,
    existingVpcNames:Array.isArray(t?.existingVpcNames)?t.existingVpcNames:[],
    organizationReuse:t?.organization==="EXISTS",
    configurationRevision:v?.universalConfigRevision??""
  };
  // The draft intentionally cannot pass completeLandingZoneBlueprint:
  // topology, policy authority, evidence and execution contracts absent.
  return {disposition:issues.length?"BLOCKED":"REVIEW_REQUIRED",
    issues:[...new Set(issues)],
    ...(intake.bundleSha256?{intakeSha256:intake.bundleSha256}:{}),
    officialSchema:issues.includes("OFFICIAL_LZA_VALIDATION_UNVERIFIED")?
      "NOT_ACCEPTED":"VERIFIED_VERSION_MATCHED",
    mapped,blueprintComplete:false,mayApply:false,actEnabled:false};
}
