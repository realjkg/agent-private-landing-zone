import { createDiscoveryAwsCli, verifierBinarySha256 } from "../observe/aws-cli.js";
import { createDiscoveryArmReader, type ArmHttp } from "../observe/azure-rest.js";
import { cloudControlReader, observeBlueprint, type AwsCli, type ObserveReport, type ResourceReader } from "../observe/verify.js";
import { canonicalJson } from "../teardown/manifest.js";
import { sha256 } from "../util/sha256.js";
import type { CleanupProposal } from "./cleanup-proposal.js";
import { contractRefusal, loadPilotContract, type Refusal } from "./contract.js";
import { readCleanupEvidence } from "./ledger.js";
import { verifyLeftovers } from "./leftovers.js";
import { readAppliedEvidence } from "./live-record.js";
import type { AwsTarget } from "./providers/aws.js";
import type { AzureTarget } from "./providers/azure.js";
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
  evidenceDir: string;
  env?: NodeJS.ProcessEnv;
  toolDirs?: readonly string[];
  scratchParent?: string;
  now?: () => Date;
  /** Test seam: the AWS verifier's CLI. Production builds it from the DISCOVERY identity. */
  aws?: AwsCli;
  /** Test seam: the Azure reader's HTTP client. Production uses fetch against the two Azure hosts. */
  arm?: ArmHttp;
};

const refuse = (code: ApplyRefusalCode, message: string): Refusal => ({ ok: false, code, message });

type OpenReader = { ok: true; reader: ResourceReader; binarySha256: string | null; close(): void };

/**
 * The contract provider's independent reader, bound to the DISCOVERY identity and the environment's target: AWS Cloud
 * Control through the aws CLI in the target's region, or Azure Resource Manager in process in the target's subscription.
 * The Terraform engine is the only one with a cleanup path, and both of its providers read here.
 */
export function openReader(deps: ObserveDeps, environment: ApplyEvidence["environment"]): OpenReader | Refusal {
  const contract = loadPilotContract(deps.contractPath);
  if ("reason" in contract) return contractRefusal(contract);
  const target = contract.targets[environment];
  if (!target) return refuse("TARGET_NOT_IN_CONTRACT", "The contract does not enable " + environment + ".");
  if (contract.provider === "AWS") {
    const region = (target as AwsTarget).region;
    if (deps.aws) return { ok: true, reader: cloudControlReader(deps.aws, region), binarySha256: null, close: () => undefined };
    const cli = createDiscoveryAwsCli({ env: deps.env, toolDirs: deps.toolDirs, scratchParent: deps.scratchParent });
    return { ok: true, reader: cloudControlReader(cli.aws, region), binarySha256: verifierBinarySha256({ env: deps.env, toolDirs: deps.toolDirs }), close: cli.close };
  }
  if (contract.provider === "AZURE") {
    try {
      const opened = createDiscoveryArmReader({ env: deps.env, subscriptionId: (target as AzureTarget).subscriptionId, http: deps.arm });
      return { ok: true, reader: opened.reader, binarySha256: null, close: opened.close };
    } catch {
      return refuse("CONTRACT_INVALID", "The contract's Azure target does not name a subscription the reader can use. Nothing was run.");
    }
  }
  return refuse("CLEANUP_NOT_SUPPORTED", "Independent observation exists for AWS and Azure; the " + String(contract.provider) + " verifier does not exist. Nothing was run.");
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
  const opened = openReader(deps, applied.environment);
  if (!opened.ok) return opened;
  let report: ObserveReport;
  try {
    // Existence of each recorded identifier and the sweep by the run's unit tag. Nothing here lists what a resource group holds: a
    // pilot cleanup never deletes a group, so its contents are not a deletion decision (docs/observe-and-cleanup.md).
    report = await observeBlueprint(blueprint.blueprint, { unitId: blueprint.unitId, reader: opened.reader });
  } finally {
    opened.close();
  }
  const origins = new Map(blueprint.blueprint.entries.map((entry) => [entry.address, entry.origin]));
  const resources: ObservedResource[] = report.checks.map((check) => ({
    address: check.address, type: check.type, identifier: check.identifier, origin: origins.get(check.address) ?? "NOT_IN_PLAN", ...verificationOf(check.existence, check.reason),
  }));
  const record: ObservationRecord = {
    schemaVersion: 1, kind: "OBSERVATION", artifactSha256, applyEvidenceSha256, blueprintSha256: recordSha256(blueprint), environment: applied.environment, target: { ...applied.target },
    sourceCommit: applied.sourceCommit, contractSha256: applied.contractSha256, verifier: report.verifier,
    verifierBinarySha256: opened.binarySha256, verdict: report.verdict, resources,
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
  const opened = openReader(deps, proposal.environment);
  if (!opened.ok) return opened;
  // The blueprint the proposal was derived from: its identifiers tell a tag listing's known entries from leftovers.
  const blueprint = await readBlueprintRecord(proposal.artifactSha256, proposal.applyEvidenceSha256, deps.evidenceDir);
  if (!blueprint || recordSha256(blueprint) !== proposal.blueprintSha256) return refuse("RUN_RECORD_MISSING", "The blueprint this proposal names is not the one recorded for this apply.");
  const knownIdentifiers = [...blueprint.blueprint.entries.flatMap((entry) => [entry.arn, entry.id]), blueprint.blueprint.container?.identifier ?? null].filter((x): x is string => x !== null);
  const cleanup = await readCleanupEvidence(proposal.proposalSha256, deps.evidenceDir);
  let record: LeftoversRecord;
  try {
    record = await verifyLeftovers({
      proposal, cleanup, cleanupEvidenceSha256: cleanup ? sha256(canonicalJson(cleanup as never)) : null, unitId: proposal.unitId, knownIdentifiers, reader: opened.reader,
      verifierBinarySha256: opened.binarySha256, now: (deps.now ?? (() => new Date()))(),
    });
  } finally {
    opened.close();
  }
  const written = await writeLeftoversRecord(record, deps.evidenceDir);
  if (written !== "WRITTEN") return refuse("EVIDENCE_REJECTED", "The leftover check could not be recorded (" + written + ").");
  return { ok: true, record, cleanupRan: cleanup !== undefined };
}
