import { OperationStore, type EffectDisposition, type Receipt } from "./operation-store.js";
import { decideRemoval, removalCardDigest, validateRemovalCard, REMOVAL_WORKFLOW_ID, type RemovalCard, type RemovalDecision, type RemovalObservations } from "./removal.js";
import type { AftLzaReader } from "./run.js";

/**
 * One step of the removal run: read what exists, decide, and journal the intent before a person is asked to act. Reads go
 * through the same read-only reader as the forward run. Re-running after any interruption lands on the same decision.
 */
export type RemovalReport = {
  schemaVersion: 1;
  workflow: typeof REMOVAL_WORKFLOW_ID;
  runId: string;
  cardDigest: string;
  decision: RemovalDecision;
  journal: { aft?: EffectDisposition; unmanage?: EffectDisposition; lza?: EffectDisposition };
  observations: RemovalObservations;
  evidenceLabel: "LIVE_READ_ONLY" | "SYNTHETIC";
  accountClosedByRunner: false;
  actStartedByRunner: false;
};

export type RemovalAction = "aft" | "unmanage" | "lza";

const ACTION: Record<RemovalAction, (runId: string) => string> = {
  aft: (runId) => runId + ":removal-aft",
  unmanage: (runId) => runId + ":removal-unmanage",
  lza: (runId) => runId + ":removal-lza",
};

const digestOf = (card: RemovalCard, which: RemovalAction): string =>
  which === "aft" ? card.aft.removalDigest : which === "lza" ? card.lza.configurationDigest : removalCardDigest(card);

/** The action the decision asks a person to perform, if any. */
export function offeredAction(decision: RemovalDecision): RemovalAction | undefined {
  if (decision.phase === "AWAIT_AFT_REMOVAL") return "aft";
  if (decision.phase === "AWAIT_UNMANAGE") return "unmanage";
  if (decision.phase === "AWAIT_LZA_MOVE") return "lza";
  return undefined;
}

/** The person records what they did: a merge commit for AFT and LZA, the account id for the Control Tower unmanage. */
export function recordRemoval(store: OperationStore, card: RemovalCard, which: RemovalAction, value: string): void {
  if (which === "unmanage") {
    if (!/^\d{12}$/.test(value)) throw new Error("ACCOUNT_ID_MUST_BE_12_DIGITS");
  } else if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error("MERGE_COMMIT_MUST_BE_FULL_SHA");
  }
  const action = ACTION[which](card.runId);
  if (!store.hasIntent(action)) throw new Error("NO_INTENT: the runner had not offered this step; run the stage first");
  const receipt: Receipt = which === "unmanage" ? { accountId: value } : { mergeCommit: value, repository: which === "aft" ? card.aft.repository : card.lza.repository };
  store.confirmEffect(action, digestOf(card, which), receipt);
}

export async function advanceRemoval(card: RemovalCard, store: OperationStore, reader: AftLzaReader, label: "LIVE_READ_ONLY" | "SYNTHETIC" = "SYNTHETIC"): Promise<RemovalReport> {
  const base = { schemaVersion: 1 as const, workflow: REMOVAL_WORKFLOW_ID, runId: card.runId, evidenceLabel: label,
    accountClosedByRunner: false as const, actStartedByRunner: false as const };
  const obs: RemovalObservations = {};
  const journal: RemovalReport["journal"] = {};
  if (validateRemovalCard(card).length > 0) return { ...base, cardDigest: "", decision: decideRemoval(card, obs), journal, observations: obs };

  obs.aftRemovalCommit = store.receipt(ACTION.aft(card.runId))?.mergeCommit;
  if (obs.aftRemovalCommit) {
    obs.aftRemovalExecution = (await reader.pipelineExecutions(card.aft.requestPipelineName, card.homeRegion)).filter((e) => e.sourceRevision === obs.aftRemovalCommit).at(-1);
  }
  obs.unmanagedAccountId = store.receipt(ACTION.unmanage(card.runId))?.accountId;
  obs.lzaMoveCommit = store.receipt(ACTION.lza(card.runId))?.mergeCommit;
  if (obs.lzaMoveCommit) {
    obs.lzaMoveExecution = (await reader.pipelineExecutions(card.lza.pipelineName, card.homeRegion)).filter((e) => e.sourceRevision === obs.lzaMoveCommit).at(-1);
  }
  if (obs.lzaMoveExecution?.status === "Succeeded") {
    const found = await reader.findAccountByEmail(card.account.email);
    obs.accountLookup = found.lookup;
    if (found.lookup === "FOUND") obs.account = found.account;
  }

  const decision = decideRemoval(card, obs);
  const offered = offeredAction(decision);
  if (offered) journal[offered] = store.beginEffect(ACTION[offered](card.runId), digestOf(card, offered));
  const reconcile = offered !== undefined && journal[offered] === "RECONCILE";
  return {
    ...base, cardDigest: removalCardDigest(card), journal, observations: obs,
    decision: reconcile
      ? { ...decision, code: decision.code + "_RECONCILE", mutationByPerson: false,
        nextAction: offered === "unmanage"
          ? "This step was already offered. Check AWS Control Tower for account " + card.account.accountId + " before unmanaging it again; record its account id."
          : "This step was already offered. Check " + (offered === "aft" ? card.aft.repository : card.lza.repository) + " for an open or merged change carrying run " + card.runId + " before opening another; record its merge commit." }
      : decision,
  };
}
