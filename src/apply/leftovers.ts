import { checkResource, unexpectedTagged, type AwsCli } from "../observe/verify.js";
import type { CleanupProposal } from "./cleanup-proposal.js";
import type { LeftoverResource, LeftoversRecord } from "./run-records.js";
import type { CleanupEvidence } from "./types.js";

/**
 * The independent leftover check after a cleanup (docs/observe-and-cleanup.md): for every resource the approved proposal
 * listed, what the cloud says now, read through the same read-only boundary the observation used (Cloud Control, the
 * DISCOVERY identity) and never through the engine. It deletes nothing and never trusts the cleanup's own exit code:
 * a resource is CONFIRMED_DELETED only when the cloud no longer returns it (or, for a setting Cloud Control cannot read
 * alone, when the resource it belongs to is gone), and completion is reported only when every proposed deletion is
 * confirmed. Anything pending or unknown keeps the disposition INCOMPLETE and says what a person does next.
 */
export type LeftoversInput = {
  proposal: CleanupProposal;
  /** The finished cleanup evidence, when the cleanup ran; absent before it ran or when it is still reserved. */
  cleanup: CleanupEvidence | undefined;
  cleanupEvidenceSha256: string | null;
  /** The deletion-unit tag of this run, when it has one; the pilot apply does not tag yet, so null is the usual value. */
  unitId: string | null;
  region: string;
  aws: AwsCli;
  verifierBinarySha256: string | null;
  now: Date;
};

type Checked = Awaited<ReturnType<typeof checkResource>>;

const finished = (cleanup: CleanupEvidence | undefined): boolean => cleanup !== undefined && cleanup.outcome === "SUCCEEDED";

/** One proposed deletion's disposition from its own check and, for a setting, its parent's. */
function dispositionOf(check: Checked, parentAbsent: boolean, cleanup: CleanupEvidence | undefined): Pick<LeftoverResource, "disposition" | "basis" | "reason"> {
  if (check.existence === "ABSENT") return { disposition: "CONFIRMED_DELETED", basis: "CLOUD_CONTROL_ABSENT" };
  if (check.existence === "NOT_CHECKABLE") {
    return parentAbsent ? { disposition: "CONFIRMED_DELETED", basis: "PARENT_ABSENT" }
      : { disposition: "UNKNOWN", basis: "NOT_INDEPENDENTLY_CHECKABLE", reason: "a setting Cloud Control cannot read alone, and the resource it belongs to is not confirmed gone" };
  }
  if (check.existence === "PRESENT") {
    if (check.pendingDeletion) return { disposition: "DELETION_PENDING", basis: "CLOUD_CONTROL_PRESENT", reason: "the cloud reports the resource scheduled for deletion; it is removed after its waiting period" };
    return finished(cleanup)
      ? { disposition: "STILL_PRESENT", basis: "CLOUD_CONTROL_PRESENT", reason: "the cleanup reported success but the resource still exists" }
      : { disposition: "DELETION_PENDING", basis: "CLEANUP_NOT_FINISHED", reason: cleanup === undefined ? "the cleanup has not run" : "the cleanup ended " + cleanup.outcome };
  }
  return { disposition: "UNKNOWN", basis: "CHECK_FAILED", reason: check.reason ?? "CLI_ERROR" };
}

/** Reads every proposed resource and writes nothing; the caller stores the record. */
export async function verifyLeftovers(input: LeftoversInput): Promise<LeftoversRecord> {
  const { proposal, cleanup } = input;
  const checks = new Map<string, Checked>();
  for (const item of proposal.deletes) {
    checks.set(item.address, await checkResource({ address: item.address, type: item.type, arn: item.identifier?.startsWith("arn:") ? item.identifier : null,
      id: item.identifier !== null && !item.identifier.startsWith("arn:") ? item.identifier : null, origin: "IN_PLAN" }, input.region, input.aws));
  }
  // A setting (a bucket's versioning, a role's policy attachment) shares its parent's identifier: when a checkable resource with the same identifier is gone, so is the setting.
  const absentIdentifiers = new Set([...checks.values()].filter((check) => check.existence === "ABSENT" && check.identifier !== null).map((check) => check.identifier as string));
  const resources: LeftoverResource[] = [];
  for (const item of proposal.deletes) {
    const check = checks.get(item.address)!;
    const parentAbsent = item.identifier !== null && absentIdentifiers.has(item.identifier);
    resources.push({ address: item.address, type: item.type, identifier: item.identifier, ...dispositionOf(check, parentAbsent, cleanup) });
  }
  for (const item of proposal.alreadyAbsent) {
    const check = await checkResource({ address: item.address, type: item.type, arn: item.identifier?.startsWith("arn:") ? item.identifier : null,
      id: item.identifier !== null && !item.identifier.startsWith("arn:") ? item.identifier : null, origin: "IN_PLAN" }, input.region, input.aws);
    resources.push({ address: item.address, type: item.type, identifier: item.identifier, ...(check.existence === "ABSENT" || check.existence === "NOT_CHECKABLE"
      ? { disposition: "CONFIRMED_DELETED" as const, basis: "CLOUD_CONTROL_ABSENT" as const }
      : check.existence === "PRESENT" ? { disposition: "STILL_PRESENT" as const, basis: "CLOUD_CONTROL_PRESENT" as const, reason: "it was absent when the cleanup was proposed and exists again" }
      : { disposition: "UNKNOWN" as const, basis: "CHECK_FAILED" as const, reason: check.reason ?? "CLI_ERROR" }) });
  }
  for (const item of proposal.excluded) {
    resources.push({ address: item.address, type: item.type, identifier: item.identifier, disposition: "INTENTIONALLY_RETAINED", basis: "RETENTION_DECISION", reason: item.reason, owner: item.ownership });
  }
  // Resources outside the engine's state: only findable by the run's unit tag, which the pilot apply does not set yet.
  let sweep: LeftoversRecord["sweep"] = "NOT_AVAILABLE";
  if (input.unitId !== null) {
    const known = { entries: proposal.deletes.concat(proposal.alreadyAbsent as never[], proposal.excluded as never[]).map((x) => ({ address: x.address, type: x.type, arn: x.identifier?.startsWith("arn:") ? x.identifier : null,
      id: x.identifier !== null && !x.identifier.startsWith("arn:") ? x.identifier : null, origin: "IN_PLAN" as const })), missing: [] };
    const listed = await unexpectedTagged(known, input.unitId, input.region, input.aws);
    sweep = listed.complete ? "COMPLETE" : "INCOMPLETE";
    for (const arn of listed.unexpected) resources.push({ address: "(not in state)", type: "tagged", identifier: arn, disposition: "STILL_PRESENT", basis: "CLOUD_CONTROL_PRESENT", reason: "carries this run's tag and is not in the state" });
  }
  const settled = resources.length > 0 && resources.every((x) => x.disposition === "CONFIRMED_DELETED" || x.disposition === "INTENTIONALLY_RETAINED") && sweep !== "INCOMPLETE";
  const open = resources.filter((x) => x.disposition !== "CONFIRMED_DELETED" && x.disposition !== "INTENTIONALLY_RETAINED");
  const nextAction = settled
    ? (sweep === "NOT_AVAILABLE" ? "Nothing further: every proposed resource is confirmed gone. Resources outside the engine's state were not searched for, because this run carries no unit tag." : "Nothing further: every proposed resource is confirmed gone and nothing else carries this run's tag.")
    : open.some((x) => x.disposition === "DELETION_PENDING" && x.basis === "CLEANUP_NOT_FINISHED") ? (cleanup === undefined
      ? "Run the approved cleanup, then verify leftovers again."
      : "The cleanup ended " + cleanup.outcome + ". A person reviews the state and the cloud resources by hand (docs/act-pilot-apply.md); do not propose a second cleanup until that review is done.")
    : open.some((x) => x.disposition === "DELETION_PENDING") ? "Wait for the deletion window to pass, then verify leftovers again."
    : open.some((x) => x.disposition === "STILL_PRESENT") ? "The cleanup did not remove everything it was approved for. A person reviews the listed resources by hand; a new proposal is needed for anything still to delete."
    : sweep === "INCOMPLETE" ? "The tag listing was incomplete; verify leftovers again when the tagging API answers completely."
    : "Fix the DISCOVERY identity's access or the verifier, then verify leftovers again.";
  return {
    schemaVersion: 1, kind: "LEFTOVERS", proposalSha256: proposal.proposalSha256, artifactSha256: proposal.artifactSha256, applyEvidenceSha256: proposal.applyEvidenceSha256,
    cleanupEvidenceSha256: input.cleanupEvidenceSha256, environment: proposal.environment, target: { ...proposal.target }, sourceCommit: proposal.sourceCommit, contractSha256: proposal.contractSha256,
    verifier: "AWS_CLOUD_CONTROL", verifierBinarySha256: input.verifierBinarySha256, resources, disposition: settled ? "COMPLETE" : "INCOMPLETE", sweep, nextAction, observedAt: input.now.toISOString(),
  };
}
