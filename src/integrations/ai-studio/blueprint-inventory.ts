/**
 * Immutable state projection for a user-requested executed blueprint.
 * Events are supplied by trusted execution adapters; this module never
 * performs cloud work or grants execution authority.
 */
import { sha256 } from "../../util/sha256.js";

export type BlueprintState =
  | "REQUESTED" | "DISCOVERING" | "DISCOVERED" | "PLANNED"
  | "VALIDATING" | "AWAITING_APPROVAL" | "APPROVED" | "EXECUTING"
  | "VERIFYING" | "SUCCEEDED" | "REUSED" | "BLOCKED"
  | "FAILED" | "ROLLING_BACK" | "ROLLED_BACK";

export type BlueprintItem = {
  id: string;
  kind: "GOVERNANCE" | "ACCOUNT" | "POLICY" | "NETWORK" | "IDENTITY" | "WORKLOAD" | "TOOL";
  provider: "AWS";
  resourceType: string;
  action: "READ" | "CREATE" | "UPDATE" | "DELETE" | "IMPORT";
  state: BlueprintState;
  sourceOfTruth: "EXISTING_AWS" | "BLUEPRINT" | "UNKNOWN";
  evidenceRefs: string[];
  updatedAt: string;
  detail?: string;
};

export type BlueprintEvent = {
  blueprintId: string;
  sequence: number;
  at: string;
  itemId: string;
  from: BlueprintState | null;
  to: BlueprintState;
  evidenceRefs: string[];
  /** The trusted adapter's stable source record, never an unverified success claim. */
  sourceRef: string;
  detail?: string;
  previousHash: string | null;
  hash: string;
};
export type BlueprintSnapshot = {
  blueprintId: string;
  version: number;
  items: BlueprintItem[];
  events: BlueprintEvent[];
  headHash: string | null;
  counts: Record<BlueprintState, number>;
};

const TRANSITIONS: Record<BlueprintState, readonly BlueprintState[]> = {
  REQUESTED: ["DISCOVERING", "PLANNED", "BLOCKED", "FAILED"],
  DISCOVERING: ["DISCOVERED", "REUSED", "BLOCKED", "FAILED"],
  DISCOVERED: ["REUSED", "PLANNED", "BLOCKED", "FAILED"],
  PLANNED: ["VALIDATING", "BLOCKED", "FAILED"],
  VALIDATING: ["AWAITING_APPROVAL", "BLOCKED", "FAILED"],
  AWAITING_APPROVAL: ["APPROVED", "BLOCKED", "FAILED"],
  APPROVED: ["EXECUTING", "BLOCKED", "FAILED"],
  EXECUTING: ["VERIFYING", "FAILED", "ROLLING_BACK"],
  VERIFYING: ["SUCCEEDED", "FAILED", "ROLLING_BACK"],
  SUCCEEDED: [],
  REUSED: [],
  BLOCKED: [],
  FAILED: ["ROLLING_BACK"],
  ROLLING_BACK: ["ROLLED_BACK", "FAILED"],
  ROLLED_BACK: []
};
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const EVIDENCE = /^evidence:\/\/[A-Za-z0-9._/-]{1,128}$/;
const SHA = /^[a-f0-9]{64}$/;
const TERMINAL = new Set<BlueprintState>(["SUCCEEDED", "REUSED", "BLOCKED", "ROLLED_BACK"]);
function requireValid(ok: boolean, reason: string): void {
  if (!ok) throw new Error("BLUEPRINT_" + reason);
}
function refsValid(refs: unknown): refs is string[] {
  return Array.isArray(refs) && refs.length <= 40 &&
    refs.every(x => typeof x === "string" && EVIDENCE.test(x) && !x.includes(".."));
}
function eventHash(e: Omit<BlueprintEvent,"hash">): string { return sha256(JSON.stringify(e)); }

export function createBlueprintInventory(blueprintId: string, items: BlueprintItem[]): BlueprintSnapshot {
  requireValid(ID.test(blueprintId), "ID_INVALID");
  requireValid(items.length > 0 && items.length <= 500, "ITEM_COUNT_INVALID");
  const ids = new Set<string>();
  for (const item of items) {
    requireValid(ID.test(item.id) && !ids.has(item.id), "ITEM_ID_INVALID");
    ids.add(item.id);
    requireValid(item.provider === "AWS" && item.state === "REQUESTED", "INITIAL_STATE_INVALID");
    requireValid(["GOVERNANCE","ACCOUNT","POLICY","NETWORK","IDENTITY","WORKLOAD","TOOL"].includes(item.kind), "ITEM_KIND_INVALID");
    requireValid(["READ","CREATE","UPDATE","DELETE","IMPORT"].includes(item.action), "ITEM_ACTION_INVALID");
    requireValid(["EXISTING_AWS","BLUEPRINT","UNKNOWN"].includes(item.sourceOfTruth), "OWNERSHIP_INVALID");
    requireValid(typeof item.resourceType === "string" && item.resourceType.length > 0 && item.resourceType.length <= 180, "RESOURCE_TYPE_INVALID");
    requireValid(refsValid(item.evidenceRefs) && item.evidenceRefs.length === 0, "INITIAL_EVIDENCE_INVALID");
    requireValid(Number.isFinite(Date.parse(item.updatedAt)), "TIME_INVALID");
  }
  return project(blueprintId,items.map(x=>({ ...x,evidenceRefs: [] })),[]);
}
function project(blueprintId: string,items: BlueprintItem[],events: BlueprintEvent[]): BlueprintSnapshot {
  const counts = Object.fromEntries(Object.keys(TRANSITIONS).map(x=>[x,0])) as Record<BlueprintState,number>;
  for (const item of items) counts[item.state]++;
  return { blueprintId, version: events.length, items, events,
    headHash: events.at(-1)?.hash ?? null, counts };
}

export function transitionBlueprintItem(
  current: BlueprintSnapshot,
  input: { itemId: string; to: BlueprintState; at: string; sourceRef: string; evidenceRefs: string[]; detail?: string }
): BlueprintSnapshot {
  requireValid(current.events.length < 20000, "EVENT_LIMIT");
  const item = current.items.find(x=>x.id===input.itemId);
  requireValid(!!item, "ITEM_NOT_FOUND");
  const existing = item!;
  requireValid(TRANSITIONS[existing.state].includes(input.to), "TRANSITION_DENIED");
  requireValid(ID.test(input.sourceRef), "SOURCE_REF_INVALID");
  requireValid(Number.isFinite(Date.parse(input.at)), "TIME_INVALID");
  requireValid(refsValid(input.evidenceRefs), "EVIDENCE_INVALID");
  requireValid(input.detail === undefined || input.detail.length <= 512, "DETAIL_TOO_LONG");
  if (input.to === "SUCCEEDED" || input.to === "REUSED" || input.to === "ROLLED_BACK")
    requireValid(input.evidenceRefs.length > 0, "TERMINAL_EVIDENCE_REQUIRED");
  if (input.to === "APPROVED" || input.to === "EXECUTING" || input.to === "VERIFYING")
    requireValid(input.evidenceRefs.length > 0, "AUTHORITY_EVIDENCE_REQUIRED");
  if (existing.action === "READ" && ["EXECUTING","SUCCEEDED"].includes(input.to))
    requireValid(false, "READ_ACTION_CANNOT_MUTATE");
  const eventWithoutHash: Omit<BlueprintEvent,"hash"> = {
    blueprintId: current.blueprintId,sequence: current.events.length+1,at:input.at,itemId: input.itemId,
    from: existing.state,to:input.to,evidenceRefs:[...input.evidenceRefs],sourceRef:input.sourceRef,
    ...(input.detail === undefined ? {} : {detail:input.detail}),previousHash:current.headHash
  };
  const event: BlueprintEvent = { ...eventWithoutHash,hash:eventHash(eventWithoutHash) };
  const items=current.items.map(x=>x.id!==input.itemId?x:{
    ...x,state:input.to,updatedAt:input.at,
    evidenceRefs:[...new Set([...x.evidenceRefs,...input.evidenceRefs])],
    ...(input.detail===undefined ? {} : {detail:input.detail})
  });
  return project(current.blueprintId,items,[...current.events,event]);
}
export function verifyBlueprintInventory(snapshot: BlueprintSnapshot): boolean {
  try {
    requireValid(snapshot.version===snapshot.events.length, "VERSION_INVALID");
    let prev: string|null=null;
    for(let i=0;i<snapshot.events.length;i++){
      const e=snapshot.events[i]!;
      const {hash,...unsigned}=e;
      requireValid(e.blueprintId===snapshot.blueprintId && e.sequence===i+1 &&
        e.previousHash===prev && hash===eventHash(unsigned), "HASH_MISMATCH");
      prev=hash;
    }
    requireValid(snapshot.headHash===prev, "HEAD_MISMATCH");
    const projected=Object.fromEntries(Object.keys(TRANSITIONS).map(x=>[x,0])) as Record<BlueprintState,number>;
    for(const item of snapshot.items) projected[item.state]++;
    requireValid(JSON.stringify(projected)===JSON.stringify(snapshot.counts), "COUNTS_MISMATCH");
    for(const item of snapshot.items) if(TERMINAL.has(item.state) && item.state!=="BLOCKED")
      requireValid(item.evidenceRefs.length>0, "EVIDENCE_MISSING");
    return true;
  }catch{return false;}
}
