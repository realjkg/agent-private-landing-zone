/**
 * Cost attribution for the same planning/build outcome under a baseline and
 * candidate implementation. No billing API or model cost is inferred here.
 */
export type BuildCostLane = "AI_INFERENCE" | "INFRASTRUCTURE" | "ENGINEERING_RUNTIME";
export type CostBasis = "OBSERVED" | "ESTIMATED";
export type BuildCostScenario = {
  id: string;
  /** A reviewed workload identity with identical output requirements. */
  workloadFingerprint: string;
  sourceCommit: string;
  expectedOutcome: string;
  /** Tests must attest equivalent acceptable output or no savings are claimed. */
  baselineOutcomeVerified: boolean;
  candidateOutcomeVerified: boolean;
  baseline: BuildCostRun;
  candidate: BuildCostRun;
};
export type BuildCostRun = {
  /** Unique source-bound evidence for each phase and lane. */
  entries: Array<{
    lane: BuildCostLane;
    basis: CostBasis;
    costCents: number;
    evidenceRef: string;
    /** Examples: model bill, metered machine hours, cloud billing export. */
    metric: "METERED_INFERENCE" | "COMPUTE" | "STORAGE" | "NETWORK" | "API" | "OTHER";
  }>;
};
export type BuildCostComparison = {
  id: string;
  status: "OBSERVED_REDUCTION" | "OBSERVED_NO_REDUCTION" | "ESTIMATE_ONLY" | "NOT_COMPARABLE";
  baselineCents: number | null;
  candidateCents: number | null;
  deltaCents: number | null;
  savingsBps: number | null;
  byLane: Array<{lane: BuildCostLane;baselineCents:number;candidateCents:number;deltaCents:number}>;
  issues: string[];
  /** Invoice savings require more than source-level evidence. */
  invoiceSavingsVerified: false;
  infrastructureAct: "DISABLED";
};
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{1,95}$/;
const HASH=/^[a-f0-9]{64}$/;
const COMMIT=/^[a-f0-9]{40}$/;
const REF=/^evidence:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{1,160}$/;
const LANES:BuildCostLane[]=["AI_INFERENCE","INFRASTRUCTURE","ENGINEERING_RUNTIME"];
const METRICS=["METERED_INFERENCE","COMPUTE","STORAGE","NETWORK","API","OTHER"];
function sum(values:number[]):number {
  const total=values.reduce((a,b)=>a+b,0);
  if(!Number.isSafeInteger(total))throw new Error("COST_AMOUNT_OVERFLOW");
  return total;
}
export function comparePlanningBuildCost(s:BuildCostScenario):BuildCostComparison {
  const issues:string[]=[];
  if(!s || typeof s!=="object") throw new Error("COST_SCENARIO_INVALID");
  if(!ID.test(s.id??"")||!HASH.test(s.workloadFingerprint??"")||
    !COMMIT.test(s.sourceCommit??"")||
    typeof s.expectedOutcome!=="string" || s.expectedOutcome.trim().length<3 ||
    s.expectedOutcome.length>500)issues.push("WORKLOAD_BINDING_INVALID");
  if(s.baselineOutcomeVerified!==true || s.candidateOutcomeVerified!==true)
    issues.push("EQUIVALENT_OUTCOME_UNVERIFIED");
  const entries=(side:"baseline"|"candidate")=>{
    const items=s[side]?.entries;
    if(!Array.isArray(items)||items.length===0||items.length>100) {
      issues.push(side+"_ENTRIES_INVALID");return [];
    }
    const used=new Set<string>();
    for(const [i,e] of items.entries()){
      if(!e || !LANES.includes(e.lane) ||
        !["OBSERVED","ESTIMATED"].includes(e.basis)||
        !METRICS.includes(e.metric)||
        !Number.isSafeInteger(e.costCents)||e.costCents<0 ||
        typeof e.evidenceRef!=="string"||!REF.test(e.evidenceRef)||
        e.evidenceRef.includes(".."))issues.push(side+"_ENTRY_INVALID:"+i);
      if(e && typeof e.evidenceRef==="string"){
        if(used.has(e.evidenceRef))issues.push(side+"_DUPLICATE_EVIDENCE");
        used.add(e.evidenceRef);
      }
    }
    return items;
  };
  const baseline=entries("baseline");
  const candidate=entries("candidate");
  const all=[...baseline,...candidate];
  const refs=all.map(e=>e?.evidenceRef);
  if(new Set(refs).size!==refs.length)issues.push("REUSED_EVIDENCE_ACROSS_RUNS");
  if(all.some(e=>!e||!Number.isSafeInteger(e.costCents)||e.costCents<0))
    return {id:s.id,status:"NOT_COMPARABLE",baselineCents:null,candidateCents:null,
      deltaCents:null,savingsBps:null,byLane:[],issues:[...new Set(issues)],
      invoiceSavingsVerified:false,infrastructureAct:"DISABLED"};
  if(issues.length)return {id:s.id,status:"NOT_COMPARABLE",baselineCents:null,
    candidateCents:null,deltaCents:null,savingsBps:null,byLane:[],
    issues:[...new Set(issues)],invoiceSavingsVerified:false,infrastructureAct:"DISABLED"};
  const byLane=LANES.map(lane=>{
    const a=sum(baseline.filter(e=>e.lane===lane).map(e=>e.costCents));
    const b=sum(candidate.filter(e=>e.lane===lane).map(e=>e.costCents));
    return {lane,baselineCents:a,candidateCents:b,deltaCents:a-b};
  });
  const a=sum(byLane.map(x=>x.baselineCents));
  const b=sum(byLane.map(x=>x.candidateCents));
  const delta=a-b;
  const bothObserved=all.every(e=>e.basis==="OBSERVED");
  return {id:s.id,
    status:!bothObserved?"ESTIMATE_ONLY":delta>0?"OBSERVED_REDUCTION":"OBSERVED_NO_REDUCTION",
    baselineCents:a,candidateCents:b,deltaCents:delta,
    savingsBps:a===0?null:Math.round(delta*10000/a),
    byLane,issues:[],
    invoiceSavingsVerified:false,infrastructureAct:"DISABLED"};
}
