import type { ChangeSet } from "../iac/changeset.js";
import type { DiscoveredResource } from "../discovery/types.js";
import { ALZ_TAG_KEYS, verifyDeletionUnit } from "./unit.js";
import type {
  CreateTraceabilityReport,
  DeletionUnit,
  DestroyPreview,
  OrphanFinding,
  OrphanReport,
  PlannedTags,
} from "./types.js";

type TerraformPlanJson = {
  resource_changes?: Array<{
    address?: string;
    change?: {
      actions?: string[];
      after?: Record<string, unknown> | null;
      after_unknown?: Record<string, unknown> | null;
    };
  }>;
};

/**
 * Tags per planned CREATE from a Terraform/OpenTofu `show -json` plan.
 * tags_all (provider default_tags merged in) wins over tags. A resource whose
 * planned state has neither attribute is UNTAGGABLE — traced through state
 * only. A tag set the provider can only compute at apply time is
 * UNKNOWN_AT_PLAN, which the create gate refuses: the plan must prove tags.
 */
export function readTerraformPlanTags(json: string): Map<string, PlannedTags> {
  const plan = JSON.parse(json) as TerraformPlanJson;
  const result = new Map<string, PlannedTags>();
  for (const change of plan.resource_changes ?? []) {
    const actions = change.change?.actions ?? [];
    if (!change.address || !actions.includes("create") || actions.includes("delete")) continue;
    const after = change.change?.after ?? {};
    const unknown = change.change?.after_unknown ?? {};
    const value = after.tags_all ?? after.tags;
    if (value && typeof value === "object") {
      const tags: Record<string, string> = {};
      for (const [key, tag] of Object.entries(value)) {
        if (typeof tag === "string") tags[key] = tag;
      }
      result.set(change.address, { kind: "TAGGED", tags });
    } else if (unknown.tags_all === true || unknown.tags === true) {
      result.set(change.address, { kind: "UNKNOWN_AT_PLAN" });
    } else if ("tags_all" in after || "tags" in after) {
      result.set(change.address, { kind: "TAGGED", tags: {} });
    } else {
      result.set(change.address, { kind: "UNTAGGABLE" });
    }
  }
  return result;
}

const MUTATING_NON_CREATE = new Set(["UPDATE", "DELETE", "REPLACE", "UNKNOWN"]);

/**
 * Creation-time traceability: the plan a build is about to preview creates
 * exactly the unit's recorded resources, changes nothing else, and stamps
 * every taggable resource with this unit's provenance tags. A local-only
 * state backend is refused because losing that file orphans the resources.
 */
export function checkCreateTraceability(
  unitInput: DeletionUnit,
  createPlan: ChangeSet,
  plannedTags?: Map<string, PlannedTags>,
): CreateTraceabilityReport {
  const unit = verifyDeletionUnit(unitInput);
  const reasons: string[] = [];
  if (createPlan.engine !== unit.engine) {
    reasons.push("ENGINE_MISMATCH: plan " + createPlan.engine + " vs unit " + unit.engine);
  }
  if ((unit.stateRef.engine === "TERRAFORM" || unit.stateRef.engine === "OPENTOFU") &&
    unit.stateRef.backend === "local") {
    reasons.push("STATE_NOT_DURABLE: a local state file can be lost, orphaning everything it tracks");
  }
  for (const resource of createPlan.resources) {
    if (MUTATING_NON_CREATE.has(resource.operation)) {
      reasons.push("NON_ADDITIVE_CHANGE: " + resource.address + " " + resource.operation);
    }
  }
  const creates = new Set(createPlan.resources
    .filter((resource) => resource.operation === "CREATE")
    .map((resource) => resource.address));
  const recorded = new Set(unit.plannedCreates);
  for (const address of creates) {
    if (!recorded.has(address)) reasons.push("CREATE_OUTSIDE_UNIT: " + address);
  }
  for (const address of recorded) {
    if (!creates.has(address)) reasons.push("PLANNED_CREATE_ABSENT: " + address);
  }

  const tagged: string[] = [];
  const stateOnly: string[] = [];
  if (plannedTags) {
    for (const address of [...creates].sort()) {
      const planned = plannedTags.get(address);
      if (!planned) {
        reasons.push("TAGS_NOT_REPORTED: " + address);
      } else if (planned.kind === "UNTAGGABLE") {
        stateOnly.push(address);
      } else if (planned.kind === "UNKNOWN_AT_PLAN") {
        reasons.push("TAGS_UNKNOWN_AT_PLAN: " + address);
      } else {
        const wrong = Object.entries(unit.tags)
          .filter(([key, value]) => planned.tags[key] !== value)
          .map(([key]) => key);
        if (wrong.length > 0) {
          reasons.push("UNTAGGED_CREATE: " + address + " missing or wrong " + wrong.join(", "));
        } else {
          tagged.push(address);
        }
      }
    }
  }
  return {
    verdict: reasons.length === 0 ? "TRACEABLE" : "BLOCKED",
    unitId: unit.unitId,
    tagCoverage: plannedTags ? "VERIFIED" : "UNVERIFIED",
    tagged,
    stateOnly,
    reasons,
  };
}

/**
 * Evaluate an engine's destroy plan (`terraform plan -destroy`, `pulumi
 * preview --destroy`, a stack deletion preview) against the unit record.
 * Ready only when the plan deletes and nothing else, and every delete is a
 * resource this unit recorded creating. Anything else in the state — such as
 * a customer resource imported into it — blocks the whole teardown rather
 * than being deleted with it. Preview only: executing it is a separate,
 * explicitly authorized ACT decision that does not exist yet.
 */
export function evaluateDestroyPreview(
  unitInput: DeletionUnit,
  destroyPlan: ChangeSet,
): DestroyPreview {
  const unit = verifyDeletionUnit(unitInput);
  const reasons: string[] = [];
  if (destroyPlan.engine !== unit.engine) {
    reasons.push("ENGINE_MISMATCH: plan " + destroyPlan.engine + " vs unit " + unit.engine);
  }
  const recorded = new Set(unit.plannedCreates);
  const deletes: string[] = [];
  for (const resource of destroyPlan.resources) {
    if (resource.operation === "DELETE") {
      deletes.push(resource.address);
      if (!recorded.has(resource.address)) {
        reasons.push("DELETE_OUTSIDE_UNIT: " + resource.address);
      }
    } else if (resource.operation !== "READ" && resource.operation !== "SAME") {
      reasons.push("NON_DELETE_IN_DESTROY_PLAN: " + resource.address + " " + resource.operation);
    }
  }
  const deleting = new Set(deletes);
  const alreadyAbsent = unit.plannedCreates.filter((address) => !deleting.has(address));
  const verdict = reasons.length > 0 ? "BLOCKED"
    : deletes.length === 0 ? "NOTHING_TO_DESTROY" : "READY_FOR_AUTHORIZATION";
  return {
    verdict,
    unitId: unit.unitId,
    unitHash: unit.unitHash,
    destroyChangeSetHash: destroyPlan.evidenceHash,
    deletes: deletes.sort(),
    alreadyAbsent,
    reasons,
    executionMode: "PREVIEW_ONLY",
    infrastructureAct: "DISABLED",
  };
}

/**
 * Report ALZ-tagged resources that no recorded unit accounts for. Report
 * only: a tag is a pointer, never authority, so nothing here marks a
 * resource deletable — an orphan is removed only by importing it into a unit
 * and destroying that unit through the same preview and authorization path.
 */
export function reportOrphans(
  resources: DiscoveredResource[],
  unitsInput: DeletionUnit[],
  today: string = new Date().toISOString().slice(0, 10),
): OrphanReport {
  const units = new Map(unitsInput.map((unit) => {
    const verified = verifyDeletionUnit(unit);
    return [verified.unitId, verified] as const;
  }));
  const findings: OrphanFinding[] = [];
  for (const resource of resources) {
    const tags = resource.tags ?? {};
    if (tags[ALZ_TAG_KEYS.managedBy] !== "alz") continue;
    const unitId = tags[ALZ_TAG_KEYS.unit];
    const expires = tags[ALZ_TAG_KEYS.expires];
    const expired = typeof expires === "string" && expires < today;
    const base = { resourceId: resource.resourceId, unitId, expired };
    if (!unitId) {
      findings.push({ ...base, status: "ORPHAN_UNATTRIBUTED",
        detail: "Tagged alz-managed-by=alz but names no deletion unit." });
    } else if (!units.has(unitId)) {
      findings.push({ ...base, status: "ORPHAN_UNKNOWN_UNIT",
        detail: "Names a deletion unit with no record here; its state may be lost." });
    } else if (tags[ALZ_TAG_KEYS.build] !== units.get(unitId)!.buildId) {
      findings.push({ ...base, status: "TAG_CONFLICT",
        detail: "Build tag does not match the unit record; treat the tags as untrusted." });
    } else {
      findings.push({ ...base, status: "TRACKED", detail: "Accounted for by its deletion unit." });
    }
  }
  return {
    action: "REPORT_ONLY",
    findings,
    orphans: findings.filter((finding) => finding.status !== "TRACKED").length,
    expired: findings.filter((finding) => finding.expired).length,
  };
}
