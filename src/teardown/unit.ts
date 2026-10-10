import { sha256 } from "../build/provenance.js";
import type { IaCEngine } from "../build/types.js";
import type { Provider } from "../discovery/types.js";
import type { ChangeSet } from "../iac/changeset.js";
import type { DeletionUnit, DeletionUnitStateRef, ProvenanceTags } from "./types.js";

/**
 * Provenance tag contract. Keys and values are chosen to be valid on every
 * target ALZ builds for: AWS tags, Azure tags (no < > % & \ ? /) and
 * Kubernetes labels (Crossplane: [a-z0-9-], at most 63 characters). Tags are
 * a pointer to the deletion unit record, never authority: anyone with tag
 * permissions can write them, so ownership still comes from discovery and the
 * unit record, and a tag alone can never make a resource deletable.
 */
export const ALZ_TAG_KEYS = {
  managedBy: "alz-managed-by",
  unit: "alz-unit",
  build: "alz-build",
  expires: "alz-expires",
} as const;

const TAG_VALUE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HASH = /^[a-f0-9]{64}$/;

function requireUnit(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error("DELETION_UNIT_INVALID:" + code);
}

/** Canonical JSON: sorted keys at every level, so equal records hash equally. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => JSON.stringify(key) + ":" +
        canonical((value as Record<string, unknown>)[key]))
      .join(",") + "}";
  }
  return JSON.stringify(value);
}

/** Deterministic unit id: one build into one state container is one unit. */
export function deletionUnitId(buildId: string, stateRef: DeletionUnitStateRef): string {
  return "alzu-" + sha256(buildId + "\n" + canonical(stateRef)).slice(0, 20);
}

export function provenanceTags(input: {
  unitId: string;
  buildId: string;
  expires?: string;
}): ProvenanceTags {
  requireUnit(TAG_VALUE.test(input.unitId), "UNIT_ID_NOT_TAG_SAFE");
  requireUnit(TAG_VALUE.test(input.buildId), "BUILD_ID_NOT_TAG_SAFE");
  if (input.expires !== undefined) {
    requireUnit(ISO_DATE.test(input.expires) &&
      !Number.isNaN(Date.parse(input.expires + "T00:00:00Z")), "EXPIRES_NOT_ISO_DATE");
  }
  return {
    [ALZ_TAG_KEYS.managedBy]: "alz",
    [ALZ_TAG_KEYS.unit]: input.unitId,
    [ALZ_TAG_KEYS.build]: input.buildId,
    ...(input.expires ? { [ALZ_TAG_KEYS.expires]: input.expires } : {}),
  } as ProvenanceTags;
}

function validateStateRef(engine: IaCEngine, ref: DeletionUnitStateRef): void {
  requireUnit(ref.engine === engine, "STATE_REF_ENGINE_MISMATCH");
  const nonEmpty = (value: unknown) => typeof value === "string" && value.trim().length > 0;
  switch (ref.engine) {
    case "TERRAFORM":
    case "OPENTOFU":
      requireUnit(nonEmpty(ref.location) && nonEmpty(ref.workspace), "TERRAFORM_STATE_REF");
      break;
    case "PULUMI":
      requireUnit(nonEmpty(ref.backendUrl) && nonEmpty(ref.stack), "PULUMI_STATE_REF");
      break;
    case "CLOUDFORMATION":
    case "AWS_CDK":
      requireUnit(nonEmpty(ref.region) && /^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(ref.stackName),
        "CLOUDFORMATION_STATE_REF");
      break;
    case "BICEP":
      requireUnit(nonEmpty(ref.scope) && nonEmpty(ref.deploymentStackName), "BICEP_STATE_REF");
      break;
    case "CROSSPLANE":
      requireUnit(nonEmpty(ref.apiVersion) && nonEmpty(ref.kind) && nonEmpty(ref.name),
        "CROSSPLANE_STATE_REF");
      break;
    default:
      requireUnit(false, "STATE_REF_UNSUPPORTED");
  }
}

/**
 * Record what a build plans to create, from its normalized create plan. The
 * unit is additive by construction: any planned UPDATE, DELETE, REPLACE or
 * UNKNOWN operation refuses the record, so a unit can only ever describe
 * resources this build itself brings into existence.
 */
export function recordDeletionUnit(input: {
  buildId: string;
  provider: Provider;
  stateRef: DeletionUnitStateRef;
  designHash: string;
  createPlan: ChangeSet;
  expires?: string;
  recordedAt?: string;
}): DeletionUnit {
  const engine = input.createPlan.engine;
  // Ansible configures existing hosts; it creates no state container to undo.
  requireUnit(engine !== "ANSIBLE", "ANSIBLE_HAS_NO_DELETION_UNIT");
  validateStateRef(engine, input.stateRef);
  requireUnit(HASH.test(input.designHash), "DESIGN_HASH");
  requireUnit(HASH.test(input.createPlan.evidenceHash), "CHANGESET_HASH");
  const nonAdditive = input.createPlan.resources.filter((resource) =>
    !["CREATE", "READ", "SAME"].includes(resource.operation));
  requireUnit(nonAdditive.length === 0, "NON_ADDITIVE_PLAN:" +
    nonAdditive.map((resource) => resource.address + "=" + resource.operation).join(","));
  const plannedCreates = [...new Set(input.createPlan.resources
    .filter((resource) => resource.operation === "CREATE")
    .map((resource) => resource.address))].sort();
  requireUnit(plannedCreates.length > 0, "NO_PLANNED_CREATES");

  const unitId = deletionUnitId(input.buildId, input.stateRef);
  const body: Omit<DeletionUnit, "unitHash"> = {
    schemaVersion: 1,
    unitId,
    buildId: input.buildId,
    provider: input.provider,
    engine: engine as DeletionUnit["engine"],
    stateRef: input.stateRef,
    designHash: input.designHash,
    createChangeSetHash: input.createPlan.evidenceHash,
    plannedCreates,
    tags: provenanceTags({ unitId, buildId: input.buildId, expires: input.expires }),
    recordedAt: input.recordedAt ?? new Date().toISOString(),
  };
  return { ...body, unitHash: sha256(canonical(body)) };
}

/** Recompute the unit hash and re-validate the record; throws when tampered. */
export function verifyDeletionUnit(unit: DeletionUnit): DeletionUnit {
  requireUnit(unit && unit.schemaVersion === 1, "SCHEMA_VERSION");
  const { unitHash, ...body } = unit;
  requireUnit(HASH.test(unitHash) && sha256(canonical(body)) === unitHash, "UNIT_HASH_MISMATCH");
  requireUnit(unit.unitId === deletionUnitId(unit.buildId, unit.stateRef), "UNIT_ID_MISMATCH");
  validateStateRef(unit.engine, unit.stateRef);
  const expected = provenanceTags({
    unitId: unit.unitId, buildId: unit.buildId, expires: unit.tags[ALZ_TAG_KEYS.expires],
  });
  requireUnit(canonical(expected) === canonical(unit.tags), "TAGS_MISMATCH");
  requireUnit(Array.isArray(unit.plannedCreates) && unit.plannedCreates.length > 0 &&
    unit.plannedCreates.every((address, index, list) =>
      // Same ordering as Array.prototype.sort() in recordDeletionUnit.
      index === 0 || list[index - 1] < address), "PLANNED_CREATES_NOT_SORTED_UNIQUE");
  return unit;
}
