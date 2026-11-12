import { OperationStore, type EffectDisposition } from "./operation-store.js";
import {
  AFT_LZA_GATE_ID, AFT_LZA_WORKFLOW_ID, cardDigest, decideNext, validateCard,
  type AccountObservation, type AftLzaCard, type ControlObservation, type Decision, type PipelineObservation, type RunObservations,
} from "./workflow.js";

/**
 * One step of the AFT/LZA run: read what exists, decide, and — when the next action is a person's write — journal the intent
 * first. Reads go through an injected reader (the read-only DISCOVERY identity); this module holds no credential and starts no
 * write. Re-running after any interruption reads the journal and the cloud again and lands on the same decision.
 */
export interface AftLzaReader {
  /** Executions of one pipeline, newest last. */
  pipelineExecutions(pipelineName: string, region: string): Promise<PipelineObservation[]>;
  findAccountByEmail(email: string): Promise<{ lookup: "FOUND"; account: AccountObservation } | { lookup: "NOT_FOUND" | "ACCESS_DENIED" }>;
  controls(accountId: string, regions: string[]): Promise<ControlObservation[]>;
}

export type Inputs = { currentLzaConfigurationDigest?: string; currentAftRequestDigest?: string };

export type StepReport = {
  schemaVersion: 1;
  workflow: typeof AFT_LZA_WORKFLOW_ID;
  gate: typeof AFT_LZA_GATE_ID;
  runId: string;
  cardDigest: string;
  decision: Decision;
  journal: { lza?: EffectDisposition; aft?: EffectDisposition };
  observations: RunObservations;
  evidenceLabel: "LIVE_READ_ONLY" | "SYNTHETIC";
  deploymentAuthorized: false;
  actStartedByRunner: false;
};

const LZA_ACTION = (runId: string): string => runId + ":lza";
const AFT_ACTION = (runId: string): string => runId + ":aft-registration";

/** The person records a merge commit after doing the write; the store binds it to the approved digest. */
export function recordMerge(store: OperationStore, card: AftLzaCard, which: "lza" | "aft", mergeCommit: string): void {
  if (!/^[0-9a-f]{40}$/.test(mergeCommit)) throw new Error("MERGE_COMMIT_MUST_BE_FULL_SHA");
  const action = which === "lza" ? LZA_ACTION(card.runId) : AFT_ACTION(card.runId);
  const digest = which === "lza" ? card.lza.configurationDigest : card.aft.requestDigest;
  if (!store.hasIntent(action)) throw new Error("NO_INTENT: the runner had not offered this write; run the step first");
  store.confirmEffect(action, digest, { mergeCommit, repository: which === "lza" ? card.lza.repository : card.aft.repository });
}

export async function advance(card: AftLzaCard, store: OperationStore, reader: AftLzaReader, inputs: Inputs = {}, label: "LIVE_READ_ONLY" | "SYNTHETIC" = "SYNTHETIC"): Promise<StepReport> {
  const base = { schemaVersion: 1 as const, workflow: AFT_LZA_WORKFLOW_ID, gate: AFT_LZA_GATE_ID, runId: card.runId, cardDigest: cardDigest(card),
    evidenceLabel: label, deploymentAuthorized: false as const, actStartedByRunner: false as const };
  const obs: RunObservations = { ...inputs };
  const journal: StepReport["journal"] = {};
  if (validateCard(card).length > 0) return { ...base, decision: decideNext(card, obs), journal, observations: obs };

  obs.lzaMergedCommit = store.receipt(LZA_ACTION(card.runId))?.mergeCommit;
  if (obs.lzaMergedCommit) {
    obs.lzaExecution = (await reader.pipelineExecutions(card.lza.pipelineName, card.homeRegion)).filter((e) => e.sourceRevision === obs.lzaMergedCommit).at(-1);
  }
  if (obs.lzaExecution?.status === "Succeeded") {
    const found = await reader.findAccountByEmail(card.account.email);
    obs.accountLookup = found.lookup;
    if (found.lookup === "FOUND") obs.account = found.account;
  }
  obs.aftMergedCommit = store.receipt(AFT_ACTION(card.runId))?.mergeCommit;
  if (obs.aftMergedCommit) {
    obs.aftRequestExecution = (await reader.pipelineExecutions(card.aft.requestPipelineName, card.homeRegion)).filter((e) => e.sourceRevision === obs.aftMergedCommit).at(-1);
  }
  if (obs.aftRequestExecution?.status === "Succeeded" && obs.account) {
    obs.customizationExecutions = await reader.pipelineExecutions(obs.account.accountId + "-customizations-pipeline", card.homeRegion);
    if (obs.customizationExecutions.at(-1)?.status === "Succeeded") obs.controls = await reader.controls(obs.account.accountId, card.regions);
  }

  const decision = decideNext(card, obs);
  // Journal the intent before telling the person to write. A second offer of the same write is RECONCILE: look it up first.
  if (decision.phase === "AWAIT_LZA_SUBMISSION") journal.lza = store.beginEffect(LZA_ACTION(card.runId), card.lza.configurationDigest);
  if (decision.phase === "AWAIT_AFT_SUBMISSION") journal.aft = store.beginEffect(AFT_ACTION(card.runId), card.aft.requestDigest);
  const reconcile = journal.lza === "RECONCILE" || journal.aft === "RECONCILE";
  return {
    ...base, journal, observations: obs,
    decision: reconcile ? { ...decision, code: decision.code + "_RECONCILE", mutationByPerson: false,
      nextAction: "This write was already offered. Check " + (journal.lza ? card.lza.repository : card.aft.repository) + " for an open or merged change carrying run " + card.runId + " before opening another; record its merge commit." } : decision,
  };
}
