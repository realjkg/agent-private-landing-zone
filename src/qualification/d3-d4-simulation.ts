import { sha256 } from "../util/sha256.js";
import { probeTargetPreflight } from "./target-preflight.js";
import { PRODUCTION_OLLAMA_VERSION } from "./model-production.js";
import { qualifyProductionIdentity } from "./identity.js";
import { qualifyProviderProduction } from "./provider-production.js";
import type { EnvironmentState } from "../discovery/types.js";
import type { ToolResult } from "../tools/types.js";

/** Synthetic injections test real admission contracts, never a cloud/model service. */
export type SimulationCase =
  | "D3_BASELINE" | "D3_MODEL_MISSING" | "D3_DIGEST_MISMATCH"
  | "D3_RESTART_FAILURE" | "D3_VALIDATOR_SKIPPED" | "D3_PROMPT_INJECTION"
  | "D4_BASELINE" | "D4_STATIC_CREDENTIAL" | "D4_FIXTURE_INVENTORY"
  | "D4_EMPTY_INVENTORY" | "D4_PREVIEW_MUTATION" | "D4_PREVIEW_FAILED";
export const SIMULATION_CASES: readonly SimulationCase[]=[
  "D3_BASELINE","D3_MODEL_MISSING","D3_DIGEST_MISMATCH","D3_RESTART_FAILURE",
  "D3_VALIDATOR_SKIPPED","D3_PROMPT_INJECTION","D4_BASELINE","D4_STATIC_CREDENTIAL",
  "D4_FIXTURE_INVENTORY","D4_EMPTY_INVENTORY","D4_PREVIEW_MUTATION","D4_PREVIEW_FAILED"
];
type SimulationResult = {
  name:SimulationCase;
  lane:"D3"|"D4";
  expected:"ACCEPT_SYNTHETIC_CONTRACT"|"REJECT";
  observed:"ACCEPT_SYNTHETIC_CONTRACT"|"REJECT";
  matched:boolean;
  reasons:string[];
  evidenceClass:"SIMULATED";
  actualInference:"NOT_RUN";
  actualAwsDiscovery:"NOT_RUN";
  actualAwsPreview:"NOT_RUN";
  actEnabled:false;
};
export type SimulationCampaign = {
  schemaVersion:1;
  sourceCommit:string;
  evidenceClass:"SIMULATED";
  qualification:"PRELIVE_ONLY";
  releaseAdmission:false;
  cases:SimulationResult[];
  passed:boolean;
  digest:string;
};
const sha=/^[a-f0-9]{40}$/;
const models=["qwen3:1.7b","qwen3:4b","mistral-nemo:latest"];
function simulateD3(kind:SimulationCase):string[]{
  const available=new Set(models);
  let pinnedDigest=true, restarted=true, validator=true, injectionDenied=true;
  if(kind==="D3_MODEL_MISSING")available.delete("qwen3:4b");
  if(kind==="D3_DIGEST_MISMATCH")pinnedDigest=false;
  if(kind==="D3_RESTART_FAILURE")restarted=false;
  if(kind==="D3_VALIDATOR_SKIPPED")validator=false;
  if(kind==="D3_PROMPT_INJECTION")injectionDenied=false;
  const reasons:string[]=[];
  if(models.some(x=>!available.has(x)))reasons.push("REQUIRED_MODEL_MISSING");
  if(!pinnedDigest)reasons.push("MODEL_DIGEST_UNPINNED");
  if(!restarted)reasons.push("MODEL_RESTART_UNVERIFIED");
  if(!validator)reasons.push("INDEPENDENT_VALIDATOR_ABSENT");
  if(!injectionDenied)reasons.push("UNTRUSTED_EVIDENCE_INJECTION_NOT_DENIED");
  return reasons;
}
function result(tool:ToolResult["tool"],command:string[]):ToolResult {
  return {tool,ok:true,exitCode:0,stdout:'{"status":"preview"}',stderr:"",durationMs:2,command};
}
function syntheticAwsEstate(kind:SimulationCase):EnvironmentState {
  return {
    provider:"AWS",classification:"BROWNFIELD",controlPlane:"EXISTING",
    resources:kind==="D4_EMPTY_INVENTORY"?[]:[{
      resourceId:"aws:account:synthetic",provider:"AWS",
      resourceType:"AWS::Organizations::Account",name:"synthetic",
      ownership:"MANAGED_BY_CUSTOMER",mutationPolicy:"READ_ONLY",sourceOfTruth:"MANUAL",
      metadata:kind==="D4_FIXTURE_INVENTORY"?{mock:true}:{}
    }],
    ownershipSummary:{readOnly:1,additiveOnly:0,updateAllowed:0,unknown:0},
    conflicts:[],safeBuildMode:"ADDITIVE_ONLY",discoveredAt:"2026-10-20T00:00:00.000Z",
    evidence:[{key:"aws.identity",value:"authenticated",source:kind==="D4_FIXTURE_INVENTORY"?"mock":"aws-cli"}],
    scannerObservations:[],sbomComponents:[],sbomComplete:false,resiliencyObservations:[],warnings:[]
  };
}
function simulateD4(kind:SimulationCase):string[]{
  const identity=qualifyProductionIdentity({
    provider:"AWS",awsCallerArn:kind==="D4_STATIC_CREDENTIAL"
      ?"arn:aws:iam::123456789012:user/example"
      :"arn:aws:sts::123456789012:assumed-role/synthetic-qualifier/test",
    environment:kind==="D4_STATIC_CREDENTIAL"
      ?{AWS_ACCESS_KEY_ID:"present",AWS_SECRET_ACCESS_KEY:"present"}
      :{AWS_ACCESS_KEY_ID:"present",AWS_SECRET_ACCESS_KEY:"present",AWS_SESSION_TOKEN:"present"},
    opaqueSecretReferencesOnly:true,modelVisibleSecretMaterial:false
  });
  const preview=result("cloudformation_preview",["aws","cloudformation","preview-update-change-set"]);
  if(kind==="D4_PREVIEW_MUTATION")preview.command=["aws","cloudformation","execute-change-set"];
  if(kind==="D4_PREVIEW_FAILED")preview.ok=false;
  const qualification=qualifyProviderProduction({
    sourceCommit:"a".repeat(40),provider:"AWS",identity,
    environment:syntheticAwsEstate(kind),
    validationResults:[result("cloudformation_validate",["aws","cloudformation","validate-template"])],
    preview,actEnabled:false
  });
  return qualification.blockers;
}
export function simulateD3D4(sourceCommit:string):SimulationCampaign {
  if(!sha.test(sourceCommit))throw new Error("SIMULATION_SOURCE_COMMIT_INVALID");
  const cases:SimulationResult[]=SIMULATION_CASES.map(name=>{
    const lane=name.startsWith("D3")?"D3":"D4";
    const expected=name.endsWith("_BASELINE")?"ACCEPT_SYNTHETIC_CONTRACT":"REJECT";
    const reasons=lane==="D3"?simulateD3(name):simulateD4(name);
    const observed=reasons.length?"REJECT":"ACCEPT_SYNTHETIC_CONTRACT";
    return {name,lane,expected,observed,matched:expected===observed,reasons,
      evidenceClass:"SIMULATED",actualInference:"NOT_RUN",actualAwsDiscovery:"NOT_RUN",
      actualAwsPreview:"NOT_RUN",actEnabled:false};
  });
  const payload={schemaVersion:1 as const,sourceCommit,evidenceClass:"SIMULATED" as const,
    qualification:"PRELIVE_ONLY" as const,releaseAdmission:false as const,cases,
    passed:cases.every(c=>c.matched)};
  return {...payload,digest:sha256(JSON.stringify(payload))};
}

/** Exercises the actual D3 Ollama metadata preflight with an injected
 * in-memory transport, not just the synthetic scenario state machine. */
export async function simulateD3Preflight(): Promise<{
  evidenceClass:"SIMULATED"; actualInference:"NOT_RUN"; releaseAdmission:false;
  expectedCases:number; matched:boolean; failures:string[];
}> {
  const cases=["BASELINE","MISSING_MODEL","BAD_DIGEST","WRONG_RUNTIME","UNREACHABLE"] as const;
  const failures:string[]=[];
  for(const kind of cases) {
    const mockedFetch:typeof fetch = async input => {
      const url=String(input);
      if(kind==="UNREACHABLE") throw new Error("SIMULATED_NETWORK_FAILURE");
      if(url.endsWith("/api/version"))return new Response(JSON.stringify({
        version:kind==="WRONG_RUNTIME"?"0.0.0":PRODUCTION_OLLAMA_VERSION
      }),{status:200});
      if(url.endsWith("/api/tags")) {
        const names=kind==="MISSING_MODEL"
          ?["qwen3:1.7b","mistral-nemo:latest"]
          :["qwen3:1.7b","qwen3:4b","mistral-nemo:latest"];
        return new Response(JSON.stringify({models:names.map(name=>({
          name,digest:kind==="BAD_DIGEST"?"invalid":"a".repeat(64),size:42
        }))}),{status:200});
      }
      throw new Error("UNEXPECTED_SYNTHETIC_URL");
    };
    const actual=await probeTargetPreflight({
      sourceCommit:"a".repeat(40),targetHardwareId:"synthetic-01",
      runnerName:"synthetic-runner",baseUrl:"http://127.0.0.1:11435",
      host:"simulation",memoryBytes:1024*1024*1024
    },mockedFetch);
    const expected=kind==="BASELINE";
    if(actual.passed!==expected)failures.push(kind+": unexpected preflight verdict");
    if(actual.actualModelInference!=="NOT_RUN" || actual.infrastructureAct!=="DISABLED")
      failures.push(kind+": unsafe evidence classification");
  }
  return {evidenceClass:"SIMULATED",actualInference:"NOT_RUN",
    releaseAdmission:false,expectedCases:cases.length,
    matched:failures.length===0,failures};
}
