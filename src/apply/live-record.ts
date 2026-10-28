import { join } from "node:path";

import { readEncryptedEvidence } from "../evidence/vault.js";
import { canonicalJson } from "../teardown/manifest.js";
import { sha256 } from "../util/sha256.js";
import { authorizeContract, pilotContractSha256, SUFFIX } from "./contract.js";
import { engineOf } from "./engine-spec.js";
import { applyEvidenceProblems } from "./evidence.js";
import { specOf } from "./provider.js";
import type { ApplyEnvironment, ApplyEvidence, PilotContract } from "./types.js";

/**
 * The live acceptance record for the execute step (config/acceptance/journeys.json, docs/act-pilot-apply.md).
 *
 * It is written only from a successful apply's own evidence, read back from the encrypted ledger, after the person who ran
 * it attests that the apply reached the real account. It carries identifiers and hashes, never plan, state or output
 * values, so it can be reviewed and committed. It is an operator attestation bound to the evidence, not machine proof that
 * the account was real: the fake-engine tests write the same evidence, which is why a person must type the attestation.
 */
export type LiveAcceptanceRecord = {
  schemaVersion: 1;
  label: "LIVE";
  step: "execute";
  cloud: string;
  engine: string;
  environment: ApplyEnvironment;
  target: ApplyEvidence["target"];
  sourceCommit: string;
  artifactSha256: string;
  outcome: "SUCCEEDED";
  /** The canonical sha256 of the apply evidence this record was made from. */
  evidenceSha256: string;
  contractSha256: string;
  /** The hash of the contract's entry that authorized the apply, from the apply's evidence. Release admission compares it with the candidate's. */
  authorizationSha256: string;
  attestedBy: string;
  attestedAt: string;
};

/** The finished apply evidence for an artifact, or undefined when it was never applied, is still reserved, or is not evidence. */
export async function readAppliedEvidence(artifactSha256: string, evidenceDir: string): Promise<ApplyEvidence | undefined> {
  if (!/^[0-9a-f]{64}$/.test(artifactSha256)) return undefined;
  try {
    const record = await readEncryptedEvidence<unknown>(join(evidenceDir, artifactSha256 + SUFFIX));
    if (applyEvidenceProblems(record).length > 0) return undefined;
    const evidence = record as ApplyEvidence;
    return evidence.artifactSha256 === artifactSha256 ? evidence : undefined;
  } catch {
    return undefined;
  }
}

/** The record for a successful apply under this reviewed contract and its current authorization, or why there is none. */
export function liveRecordOf(evidence: ApplyEvidence, contract: PilotContract, attestedBy: string, now: Date):
  { ok: true; record: LiveAcceptanceRecord } | { ok: false; reason: string } {
  if (evidence.outcome !== "SUCCEEDED") return { ok: false, reason: "The apply did not succeed (" + evidence.outcome + "), so it is not live acceptance of the execute step." };
  if (evidence.contractSha256 !== pilotContractSha256(contract)) return { ok: false, reason: "The apply ran under another pilot contract than the one committed now." };
  const authorized = authorizeContract(contract, evidence.environment, "APPLY");
  if (!authorized.ok || authorized.authorization.authorizationSha256 !== evidence.decisions.authorized.authorizationSha256) {
    return { ok: false, reason: "The apply ran under another authorization than the contract's current APPLY entry for " + evidence.environment + "." };
  }
  return {
    ok: true,
    record: {
      schemaVersion: 1, label: "LIVE", step: "execute", cloud: specOf(contract).id, engine: engineOf(contract).id, environment: evidence.environment,
      target: { ...evidence.target }, sourceCommit: evidence.sourceCommit, artifactSha256: evidence.artifactSha256, outcome: "SUCCEEDED",
      evidenceSha256: sha256(canonicalJson(evidence as never)), contractSha256: evidence.contractSha256, authorizationSha256: evidence.decisions.authorized.authorizationSha256, attestedBy, attestedAt: now.toISOString(),
    },
  };
}
