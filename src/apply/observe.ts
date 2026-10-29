import { createDiscoveryAwsCli, verifierBinarySha256 } from "../observe/aws-cli.js";
import { createDiscoveryArmReader, type ArmHttp } from "../observe/azure-rest.js";
import { createDiscoveryGcpReader, type GcpHttp } from "../observe/gcp-rest.js";
import { cloudControlReader, observeBlueprint, unexpectedOf, type AwsCli, type ObserveReport, type ResourceCheck, type ResourceReader } from "../observe/verify.js";
import { canonicalJson } from "../teardown/manifest.js";
import { sha256 } from "../util/sha256.js";
import type { CleanupProposal } from "./cleanup-proposal.js";
import { contractRefusal, loadPilotContract, type Refusal } from "./contract.js";
import { readCleanupEvidence } from "./ledger.js";
import { verifyLeftovers } from "./leftovers.js";
import { readAppliedEvidence } from "./live-record.js";
import type { AwsTarget } from "./providers/aws.js";
import type { AzureTarget } from "./providers/azure.js";
import type { GcpTarget } from "./providers/gcp.js";
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
 * Each provider's verifier is its own module behind `ResourceReader` (`openReader`).
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
  /** Test seam: the GCP reader's HTTP client. Production uses fetch against Google's token, IAM Credentials and read hosts only. */
  gcp?: GcpHttp;
};

const refuse = (code: ApplyRefusalCode, message: string): Refusal => ({ ok: false, code, message });

type OpenReader = { ok: true; reader: ResourceReader; binarySha256: string | null; close(): void };

/**
 * The contract provider's independent reader, bound to the DISCOVERY identity and the environment's target: AWS Cloud
 * Control through the aws CLI in the target's region, Azure Resource Manager in process in the target's subscription, or
 * Google's REST APIs in process in the target's project. Any other provider has no reader, and is refused.
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
    // Every Azure run is placed by the target's location (Terraform: owner decision of 2026-10-28; Bicep: a location field), so the
    // reader always checks where each resource is; a target that names none is not one an Azure run could have sealed against.
    if ((target as AzureTarget).location === undefined) {
      return refuse("CONTRACT_INVALID", "The contract's Azure " + environment + " target names no location (targets." + environment + ".location), so where the run's resources are cannot be verified. Nothing was run.");
    }
    try {
      // The target's authorized location, when it names one (Azure Terraform and Bicep): each resource found is checked against it.
      const opened = createDiscoveryArmReader({ env: deps.env, subscriptionId: (target as AzureTarget).subscriptionId, location: (target as AzureTarget).location, http: deps.arm });
      return { ok: true, reader: opened.reader, binarySha256: null, close: opened.close };
    } catch {
      return refuse("CONTRACT_INVALID", "The contract's Azure target does not name a subscription and location the reader can use. Nothing was run.");
    }
  }
  if (contract.provider === "GCP") {
    try {
      // The contract region, so the canary topic's storage policy, its only location, is read back (D11; lane G1, R2): a topic
      // stored elsewhere is `misplaced`, and the observation FAILS.
      const opened = createDiscoveryGcpReader({ env: deps.env, projectId: (target as GcpTarget).projectId, storagePolicyRegion: (target as GcpTarget).region, http: deps.gcp });
      return { ok: true, reader: opened.reader, binarySha256: null, close: opened.close };
    } catch {
      return refuse("CONTRACT_INVALID", "The contract's GCP target does not name a project the reader can use. Nothing was run.");
    }
  }
  return refuse("CLEANUP_NOT_SUPPORTED", "Independent observation exists for AWS, Azure and GCP; the " + String(contract.provider) + " verifier does not exist. Nothing was run.");
}

export type ObservationOutcome = { ok: true; record: ObservationRecord; report: ObserveReport; blueprint: BlueprintRecord; applyEvidence: ApplyEvidence } | Refusal;

/**
 * Each check in the journey's words, as an observation records it. Present but not where the contract places it is
 * DIFFERENT_FROM_DESIRED (LOCATION_NOT_IN_CONTRACT), never VERIFIED, with the location found when the answer named one.
 * The observation and the location remediation's recheck both use this one mapping, so a recheck compares like with like.
 */
export function observedResourcesOf(checks: readonly ResourceCheck[], blueprint: BlueprintRecord): ObservedResource[] {
  const origins = new Map(blueprint.blueprint.entries.map((entry) => [entry.address, entry.origin]));
  return checks.map((check) => ({
    address: check.address, type: check.type, identifier: check.identifier, origin: origins.get(check.address) ?? "NOT_IN_PLAN",
    ...(check.misplaced
      ? { result: "DIFFERENT_FROM_DESIRED" as const, reason: "LOCATION_NOT_IN_CONTRACT", ...(check.observedLocation === undefined ? {} : { observedLocation: check.observedLocation }),
        ...(check.observedLocation === undefined || check.observedResourceGuid === undefined ? {} : { observedResourceGuid: check.observedResourceGuid }) }
      : verificationOf(check.existence, check.reason)),
  }));
}

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
  const resources = observedResourcesOf(report.checks, blueprint);
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

/**
 * A location remediation's recheck (owner decision 6486426552, item 2), which the cleanup driver runs immediately before the approvals
 * are consumed and the network is deleted. It reads the cloud again through the same read-only DISCOVERY reader the observation used,
 * bound to the contract's subscription and authorized location, and requires everything the proposal rests on to be unchanged: the
 * one network is still there under its exact resource id and creation identity (`resourceGuid`), still DIFFERENT_FROM_DESIRED in the same observed location (so it moved
 * neither back nor elsewhere), still carrying this run's deletion-unit tag, and a complete sweep by that tag finds nothing else. The
 * result is compared with the observation record in the observation's own words (`observedResourcesOf`). It writes nothing: the run's
 * records, its FAILED observation among them, stay as they are. Undefined means the recheck passed; anything else is the refusal.
 */
export async function recheckLocationRemediation(proposal: CleanupProposal, blueprint: BlueprintRecord, observation: ObservationRecord, deps: ObserveDeps): Promise<Refusal | undefined> {
  const remediation = proposal.remediation;
  const failed = (why: string): Refusal => refuse("REMEDIATION_RECHECK_FAILED", "The network was read again as DISCOVERY immediately before deletion, and " + why +
    ". Nothing was deleted and no approval was consumed. Observe the run again; if the network still needs removing, propose and approve a new remediation, otherwise a person reviews it by hand.");
  if (remediation === undefined || blueprint.unitId === null || blueprint.blueprint.entries.length !== 1) return failed("the proposal is not a location remediation of one tagged network");
  const opened = openReader(deps, proposal.environment);
  if (!opened.ok) return failed("the reader could not be opened (" + opened.code + ")");
  const checks: ResourceCheck[] = [];
  let listed: { identifiers: string[]; complete: boolean } | undefined;
  try {
    for (const entry of blueprint.blueprint.entries) checks.push(await opened.reader.check(entry));
    listed = await opened.reader.listTagged(blueprint.unitId);
  } catch {
    return failed("the read did not complete");
  } finally {
    opened.close();
  }
  const [check] = checks;
  if (check.identifier === null || check.identifier !== remediation.resourceId) return failed("the state's identifier is not the proposal's resource id");
  if (check.existence === "ABSENT") return failed("the network is gone");
  if (check.existence !== "PRESENT") return failed("the network could not be read (" + (check.reason ?? check.existence) + ")");
  if (!check.misplaced) return failed("the network is now in the location the contract authorizes, so it is no longer misplaced");
  if (check.observedResourceGuid !== remediation.resourceGuid) return failed("the network's creation identity (resourceGuid) is not the one the run created: it was deleted and created again, or the answer names none");
  if (check.observedLocation !== remediation.observedLocation) return failed("the network is now in " + (check.observedLocation ?? "a location it could not name") + ", not " + remediation.observedLocation + " as proposed");
  // The same words the observation recorded, for every resource: anything else that differs means the run is not as proposed.
  if (canonicalJson(observedResourcesOf(checks, blueprint) as never) !== canonicalJson(observation.resources as never)) return failed("what it found differs from the observation the proposal binds");
  if (listed === undefined || !listed.complete) return failed("the sweep by this run's deletion unit could not be read in full");
  if (!listed.identifiers.some((id) => id.toLowerCase() === remediation.resourceId.toLowerCase())) return failed("the network no longer carries this run's deletion-unit tag");
  const unexpected = unexpectedOf(blueprint.blueprint, listed, opened.reader.verifier).unexpected;
  if (unexpected.length > 0) return failed("something else now carries this run's deletion-unit tag (" + unexpected.length + ")");
  return undefined;
}
