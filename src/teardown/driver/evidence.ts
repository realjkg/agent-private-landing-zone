import { createChangeSet, type ResourceChange } from "../../iac/changeset.js";
import { assessmentLabel, canonicalJson, recordStateVersion, type PreviewBinding, type StateVersionRecord } from "../manifest.js";
import type { DestroyPreview } from "../types.js";
import type {
  AdapterDescriptor,
  PreviewAuthority,
  PreviewEvidence,
  PreviewOperation,
  PreviewRequest,
} from "./types.js";

/**
 * Preview evidence (docs/destroy-preview-driver.md). A plan, a state document
 * and raw `show -json` output carry secrets in plaintext
 * (docs/teardown-broker-review.md, G4), so evidence holds none of them. It
 * carries the normalized change set (address, type, operation), hashes,
 * versions and the authority statement, and every field is checked against a
 * closed shape before the driver returns it.
 */
export const AUTHORITY: PreviewAuthority = {
  infrastructureAct: "DISABLED",
  mutation: "NONE",
  executionMode: "PREVIEW_ONLY",
  agentInitiated: false,
};

/** Closed shape: `true` is a scalar leaf, an object lists its only allowed keys, an array repeats one shape. */
type Shape = true | { [key: string]: Shape } | [Shape];
const SHAPE: Shape = {
  schemaVersion: true, operation: true, engine: true, mode: true,
  adapter: { engine: true, adapterVersion: true, argvDigest: true },
  toolVersions: { engine: true, adapter: true },
  changes: {
    engine: true, resources: [{ address: true, type: true, operation: true }],
    creates: true, updates: true, deletes: true, replacements: true, reads: true, unchanged: true,
    unknown: true, destructive: true, evidenceHash: true,
  },
  hashes: { manifestHash: true, unitHash: true, changeSetHash: true },
  stateVersion: { kind: true, value: true, observedAt: true },
  label: true, verdict: true,
  target: { account: true, backend: true, workspace: true },
  policyVersion: true,
  invokedBy: { operatorId: true, confirmedAt: true },
  startedAt: true, finishedAt: true,
  authority: { infrastructureAct: true, mutation: true, executionMode: true, agentInitiated: true },
};

/** Keys that mean a raw plan, state or program document got in. Named so the problem is readable. */
const RAW_KEY = /^(resource_changes|resource_drift|prior_state|planned_values|root_module|configuration|variables|outputs|before|after|before_sensitive|after_sensitive|after_unknown|checkpoint|deployment|state|values|plan|raw|stdout|stderr)$/i;
const ADDRESS = /^[A-Za-z0-9_.\-[\]"':/ ]{1,300}$/;
const TYPE = /^[A-Za-z0-9_.:/-]{1,128}$/;
const MAX_STRING = 512;

function shapeProblems(value: unknown, shape: Shape, path: string, out: string[]): void {
  if (shape === true) {
    if (value !== null && typeof value === "object") out.push(path + ": expected a scalar");
    return;
  }
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) { out.push(path + ": expected a list"); return; }
    value.forEach((item, index) => shapeProblems(item, shape[0], path + "[" + index + "]", out));
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) { out.push(path + ": expected an object"); return; }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(key in shape)) {
      out.push(path + "." + key + (RAW_KEY.test(key) ? ": raw plan or state field" : ": not part of the evidence shape"));
    } else {
      shapeProblems(record[key], shape[key], path + "." + key, out);
    }
  }
}

function leafStrings(value: unknown, path: string, out: Array<[string, string]>): void {
  if (typeof value === "string") out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((item, index) => leafStrings(item, path + "[" + index + "]", out));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) leafStrings(child, path + "." + key, out);
  }
}

const looksLikeJson = (text: string): boolean => {
  const trimmed = text.trim();
  if (!/^[{[]/.test(trimmed)) return false;
  try { return typeof JSON.parse(trimmed) === "object"; } catch { return false; }
};

/**
 * Every reason this evidence could hold raw plan or state content. Empty means
 * clean. `canaries` are known secret strings a test planted; production passes
 * none, and the structural rules (closed shape, restricted address characters,
 * no JSON-looking or oversized strings) do the work.
 */
export function evidenceProblems(evidence: unknown, canaries: readonly string[] = []): string[] {
  const problems: string[] = [];
  shapeProblems(evidence, SHAPE, "evidence", problems);
  const strings: Array<[string, string]> = [];
  leafStrings(evidence, "evidence", strings);
  for (const [path, text] of strings) {
    if (text.length > MAX_STRING) problems.push(path + ": string over " + MAX_STRING + " characters");
    else if (looksLikeJson(text)) problems.push(path + ": string is a JSON document");
    if (/\.address$/.test(path) && !ADDRESS.test(text)) problems.push(path + ": not a resource address");
    if (/\.type$/.test(path) && !TYPE.test(text)) problems.push(path + ": not a resource type");
  }
  const serialized = JSON.stringify(evidence) ?? "";
  for (const canary of canaries) {
    if (canary.length > 0 && serialized.includes(canary)) problems.push("a known secret value is present");
  }
  return problems;
}

/** Throws unless the evidence is clean. This is the proof tests and the driver rely on. */
export function assertNoRawPayload(evidence: unknown, canaries: readonly string[] = []): void {
  const problems = evidenceProblems(evidence, canaries);
  if (problems.length > 0) throw new Error("EVIDENCE_REJECTED:" + problems.slice(0, 8).join("; "));
}

/**
 * Builds evidence from an adapter's normalized resources. Only address, type
 * and operation of each resource survive: createChangeSet drops the rest. The
 * label is INVENTORY_ONLY until the driver binds it; an adapter cannot award
 * itself the validated label.
 */
export function buildEvidence(input: {
  request: PreviewRequest;
  operation: PreviewOperation;
  adapter: AdapterDescriptor;
  /** The engine version the adapter observed running. The driver compares it with the request. */
  observedEngineVersion: string;
  resources: ResourceChange[];
  stateVersion: StateVersionRecord;
  startedAt?: string;
  finishedAt?: string;
}): PreviewEvidence {
  const { request } = input;
  const changes = createChangeSet(request.engine, input.resources);
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    operation: input.operation,
    engine: request.engine,
    mode: request.mode,
    adapter: { ...input.adapter },
    toolVersions: { engine: input.observedEngineVersion, adapter: input.adapter.adapterVersion },
    changes,
    hashes: {
      manifestHash: request.manifest.manifestHash,
      unitHash: request.unit.unitHash,
      changeSetHash: changes.evidenceHash,
    },
    stateVersion: recordStateVersion(input.stateVersion),
    label: assessmentLabel(undefined),
    verdict: null,
    target: { ...request.target },
    policyVersion: request.policyVersion,
    invokedBy: { operatorId: request.invocation.operatorId, confirmedAt: request.invocation.confirmedAt },
    startedAt: input.startedAt ?? now,
    finishedAt: input.finishedAt ?? now,
    authority: { ...AUTHORITY },
  };
}

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

/**
 * Checks what an adapter returned against what the driver asked for. The
 * adapter's word is not enough: the shape must be closed and clean, the
 * identity of the run must match the request, and the change set must be
 * exactly what normalizing its own resources produces.
 */
export function checkAdapterEvidence(
  candidate: unknown,
  expected: { request: PreviewRequest; operation: PreviewOperation; adapter: AdapterDescriptor },
): PreviewEvidence {
  assertNoRawPayload(candidate);
  const evidence = candidate as PreviewEvidence;
  const { request } = expected;
  const reject = (what: string): never => { throw new Error("EVIDENCE_REJECTED:" + what); };
  if (evidence.schemaVersion !== 1) reject("schemaVersion");
  if (evidence.operation !== expected.operation) reject("operation differs from the one requested");
  if (evidence.engine !== request.engine || evidence.mode !== request.mode) reject("engine or mode differs from the request");
  if (!same(evidence.adapter, expected.adapter)) reject("adapter identity differs from the qualified adapter");
  if (evidence.toolVersions.engine !== request.resolved.engineVersion) {
    reject("the adapter observed engine version " + evidence.toolVersions.engine + ", not the validated " + request.resolved.engineVersion);
  }
  if (evidence.toolVersions.adapter !== expected.adapter.adapterVersion) reject("adapter version");
  if (evidence.hashes.manifestHash !== request.manifest.manifestHash) reject("manifestHash differs from the validated manifest");
  if (evidence.hashes.unitHash !== request.unit.unitHash) reject("unitHash differs from the deletion unit");
  if (!same(evidence.invokedBy, { operatorId: request.invocation.operatorId, confirmedAt: request.invocation.confirmedAt })) {
    reject("invokedBy differs from the invocation record");
  }
  if (!same(evidence.target, request.target) || evidence.policyVersion !== request.policyVersion) reject("target or policy version");
  if (evidence.changes.engine !== request.engine) reject("change set engine");
  if (!same(evidence.changes, createChangeSet(evidence.changes.engine, evidence.changes.resources))) {
    reject("the change set is not the normalization of its own resources");
  }
  if (evidence.hashes.changeSetHash !== evidence.changes.evidenceHash) reject("changeSetHash");
  recordStateVersion(evidence.stateVersion);
  return evidence;
}

/** The driver's own record of a run: label, verdict, clock and authority come from the driver, not the adapter. */
export function finalizeEvidence(
  checked: PreviewEvidence,
  outcome: {
    binding: PreviewBinding;
    verdict: DestroyPreview["verdict"] | null;
    startedAt: string;
    finishedAt: string;
  },
): PreviewEvidence {
  const final: PreviewEvidence = {
    ...checked,
    stateVersion: outcome.binding.stateVersion,
    label: assessmentLabel(outcome.binding),
    verdict: outcome.verdict,
    startedAt: outcome.startedAt,
    finishedAt: outcome.finishedAt,
    authority: { ...AUTHORITY },
  };
  assertNoRawPayload(final);
  return final;
}
