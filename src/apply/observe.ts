import { createDiscoveryAwsCli, verifierBinarySha256 } from "../observe/aws-cli.js";
import { observeBlueprint, type AwsCli, type ObserveReport } from "../observe/verify.js";
import { canonicalJson } from "../teardown/manifest.js";
import { sha256 } from "../util/sha256.js";
import type { CleanupProposal } from "./cleanup-proposal.js";
import { contractRefusal, loadPilotContract, type Refusal } from "./contract.js";
import { readCleanupEvidence } from "./ledger.js";
import { verifyLeftovers } from "./leftovers.js";
import { readAppliedEvidence } from "./live-record.js";
import type { AwsTarget } from "./providers/aws.js";
import {
  readBlueprintRecord, readObservationRecord, recordSha256, verificationOf, writeLeftoversRecord, writeObservationRecord,
  type BlueprintRecord, type LeftoversRecord, type ObservationRecord, type ObservedResource,
} from "./run-records.js";
import type { ApplyEvidence, ApplyRefusalCode } from "./types.js";

/**
 * The observe step and the leftover check (docs/observe-and-cleanup.md), as `./alz apply observe` and
 * `./alz apply verify-cleanup` run them: both read the ledger for the run's own records, ask the cloud through the
 * read-only DISCOVERY boundary, and write a record of what they found. Neither runs an engine, consumes an approval or
 * changes anything, so either may be repeated: a reconnect observes again, it never applies or cleans up again.
 * The AWS Cloud Control verifier is the only one so far; another provider's verifier is another module behind `AwsCli`.
 */
export type ObserveDeps = {
  contractPath?: string;
  contractPinPath?: string;
  evidenceDir: string;
  env?: NodeJS.ProcessEnv;
  toolDirs?: readonly string[];
  scratchParent?: string;
  now?: () => Date;
  /** Test seam: the verifier's CLI. Production builds it from the DISCOVERY identity. */
  aws?: AwsCli;
};

const refuse = (code: ApplyRefusalCode, message: string): Refusal => ({ ok: false, code, message });

/** The region the DISCOVERY identity reads in: the contract target's. Only AWS has a verifier today. */
function regionOf(deps: ObserveDeps, environment: ApplyEvidence["environment"]): { ok: true; region: string } | Refusal {
  const contract = loadPilotContract(deps.contractPath, deps.contractPinPath);
  if ("reason" in contract) return contractRefusal(contract);
  if (contract.provider !== "AWS") return refuse("CLEANUP_NOT_SUPPORTED", "Independent observation exists for AWS only so far; the " + contract.provider + " verifier is a later slice. Nothing was run.");
  const target = contract.targets[environment] as AwsTarget | undefined;
  if (!target) return refuse("TARGET_NOT_IN_CONTRACT", "The contract does not enable " + environment + ".");
  return { ok: true, region: target.region };
}

export type ObservationOutcome = { ok: true; record: ObservationRecord; report: ObserveReport; blueprint: BlueprintRecord; applyEvidence: ApplyEvidence } | Refusal;

/** Observes one run: its blueprint's identifiers against the cloud, recorded under the artifact. */
export async function observeRun(artifactSha256: string, deps: ObserveDeps): Promise<ObservationOutcome> {
  const applied = await readAppliedEvidence(artifactSha256, deps.evidenceDir);
  if (!applied) return refuse("RUN_RECORD_MISSING", "This plan has no finished apply evidence. Observation follows an apply that ran and was recorded.");
  const applyEvidenceSha256 = sha256(canonicalJson(applied as never));
  const blueprint = await readBlueprintRecord(artifactSha256, applyEvidenceSha256, deps.evidenceDir);
  if (!blueprint) {
    return refuse("RUN_RECORD_MISSING", "This apply left no blueprint: its state could not be read when it ended (" + applied.outcome + "). A person reviews the state and the cloud by hand; nothing can be observed or cleaned up from here.");
  }
  const region = regionOf(deps, applied.environment);
  if (!region.ok) return region;
  const cli = deps.aws ? { aws: deps.aws, close: () => undefined } : createDiscoveryAwsCli({ env: deps.env, toolDirs: deps.toolDirs, scratchParent: deps.scratchParent });
  let report: ObserveReport;
  try {
    report = await observeBlueprint(blueprint.blueprint, { unitId: null, region: region.region, aws: cli.aws });
  } finally {
    cli.close();
  }
  const origins = new Map(blueprint.blueprint.entries.map((entry) => [entry.address, entry.origin]));
  const resources: ObservedResource[] = report.checks.map((check) => ({
    address: check.address, type: check.type, identifier: check.identifier, origin: origins.get(check.address) ?? "NOT_IN_PLAN", ...verificationOf(check.existence, check.reason),
  }));
  const record: ObservationRecord = {
    schemaVersion: 1, kind: "OBSERVATION", artifactSha256, applyEvidenceSha256, blueprintSha256: recordSha256(blueprint), environment: applied.environment, target: { ...applied.target },
    sourceCommit: applied.sourceCommit, contractSha256: applied.contractSha256, verifier: report.verifier,
    verifierBinarySha256: deps.aws ? null : verifierBinarySha256({ env: deps.env, toolDirs: deps.toolDirs }), verdict: report.verdict, resources,
    missingFromState: [...report.missingFromState], unexpected: [...report.unexpected], inventory: report.inventory, observedAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
  const written = await writeObservationRecord(record, deps.evidenceDir);
  if (written !== "WRITTEN") return refuse("EVIDENCE_REJECTED", "The observation could not be recorded (" + written + ").");
  return { ok: true, record, report, blueprint, applyEvidence: applied };
}

/** Everything a cleanup proposal is built from, read back from the ledger and bound by hash. */
export async function loadRunRecords(artifactSha256: string, evidenceDir: string): Promise<
  { ok: true; applyEvidence: ApplyEvidence; applyEvidenceSha256: string; blueprint: BlueprintRecord; blueprintSha256: string; observation: ObservationRecord; observationSha256: string } | Refusal> {
  const applied = await readAppliedEvidence(artifactSha256, evidenceDir);
  if (!applied) return refuse("RUN_RECORD_MISSING", "This plan has no finished apply evidence.");
  const applyEvidenceSha256 = sha256(canonicalJson(applied as never));
  const blueprint = await readBlueprintRecord(artifactSha256, applyEvidenceSha256, evidenceDir);
  if (!blueprint) return refuse("RUN_RECORD_MISSING", "This apply left no blueprint, so what it created cannot be told. A person reviews by hand.");
  const observation = await readObservationRecord(artifactSha256, applyEvidenceSha256, evidenceDir);
  if (!observation) return refuse("RUN_RECORD_MISSING", "This run has not been observed. Run ./alz apply observe first.");
  const blueprintSha256 = recordSha256(blueprint);
  if (observation.blueprintSha256 !== blueprintSha256) return refuse("RUN_RECORD_MISSING", "The observation is not of this run's blueprint. Observe again.");
  return { ok: true, applyEvidence: applied, applyEvidenceSha256, blueprint, blueprintSha256, observation, observationSha256: recordSha256(observation) };
}

export type LeftoversOutcome = { ok: true; record: LeftoversRecord; cleanupRan: boolean } | Refusal;

/** Verifies leftovers for one proposal, before or after its cleanup, and records the result under the proposal. */
export async function verifyProposalLeftovers(proposal: CleanupProposal, deps: ObserveDeps): Promise<LeftoversOutcome> {
  const applied = await readAppliedEvidence(proposal.artifactSha256, deps.evidenceDir);
  if (!applied || sha256(canonicalJson(applied as never)) !== proposal.applyEvidenceSha256) return refuse("RUN_RECORD_MISSING", "The apply this proposal cleans up is not recorded with this evidence.");
  const region = regionOf(deps, proposal.environment);
  if (!region.ok) return region;
  const cleanup = await readCleanupEvidence(proposal.proposalSha256, deps.evidenceDir);
  const cli = deps.aws ? { aws: deps.aws, close: () => undefined } : createDiscoveryAwsCli({ env: deps.env, toolDirs: deps.toolDirs, scratchParent: deps.scratchParent });
  let record: LeftoversRecord;
  try {
    record = await verifyLeftovers({
      proposal, cleanup, cleanupEvidenceSha256: cleanup ? sha256(canonicalJson(cleanup as never)) : null, unitId: null, region: region.region, aws: cli.aws,
      verifierBinarySha256: deps.aws ? null : verifierBinarySha256({ env: deps.env, toolDirs: deps.toolDirs }), now: (deps.now ?? (() => new Date()))(),
    });
  } finally {
    cli.close();
  }
  const written = await writeLeftoversRecord(record, deps.evidenceDir);
  if (written !== "WRITTEN") return refuse("EVIDENCE_REJECTED", "The leftover check could not be recorded (" + written + ").");
  return { ok: true, record, cleanupRan: cleanup !== undefined };
}
