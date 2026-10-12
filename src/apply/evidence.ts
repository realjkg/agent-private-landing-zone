import { HASH } from "./constants.js";
import { ENGINE_IDS } from "./engine-spec.js";
import type { ProviderSpec } from "./provider.js";
import type { ApplyEvidence, EngineId } from "./types.js";

/**
 * Apply evidence shape (docs/act-pilot-plan.md, authority model 7). Same closed
 * shape pattern as src/teardown/driver/evidence.ts: every field is named, an
 * unknown key is refused, and a raw plan, state or engine-output field is named
 * as such. Evidence never carries plan values, state or raw engine output.
 */
/** Terraform's; an engine with another mutation says so in its spec (`EngineSpec.mutation`). */
export const APPLY_AUTHORITY: ApplyEvidence["authority"] = {
  infrastructureAct: "PILOT_ENABLED",
  mutation: "TERRAFORM_APPLY_OF_SEALED_PLAN",
  agentInitiated: false,
};

type Check = (value: unknown) => boolean;
type Shape = Check | { [key: string]: Shape } | [Shape];

const MAX_STRING = 256;
const text: Check = (v) => typeof v === "string" && v.length > 0 && v.length <= MAX_STRING && !/^\s*[{[]/.test(v);
const hash: Check = (v) => typeof v === "string" && HASH.test(v);
const iso: Check = (v) => typeof v === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v) && !Number.isNaN(Date.parse(v));
const oneOf = (...allowed: unknown[]): Check => (v) => allowed.includes(v);
const exitCode: Check = (v) => v === null || (typeof v === "number" && Number.isInteger(v));

/** Shapes whose key may be absent. */
const optionalShapes = new WeakSet<object>();
const optional = <S extends { [key: string]: Shape }>(shape: S): S => { optionalShapes.add(shape); return shape; };
const count: Check = (v) => typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= 16;

const SHAPE: Shape = {
  schemaVersion: oneOf(1),
  environment: oneOf("DEV", "QA", "PROD"),
  target: { account: text, backend: text, workspace: text },
  artifactSha256: hash,
  manifestHash: hash,
  releaseIdentity: text,
  contractSha256: hash,
  approvals: [{ approverId: text, issuedAt: iso }],
  adapter: { adapterVersion: text, argvDigest: hash },
  toolVersions: { engine: text },
  outcome: oneOf("SUCCEEDED", "FAILED_NO_CHANGE", "PARTIAL_REQUIRES_REVIEW", "KILLED"),
  exitCode,
  startedAt: iso,
  finishedAt: iso,
  authority: { infrastructureAct: oneOf("PILOT_ENABLED"), mutation: oneOf("TERRAFORM_APPLY_OF_SEALED_PLAN", "CLOUDFORMATION_EXECUTE_OF_SEALED_CHANGE_SET"), agentInitiated: oneOf(false) },
  // Files the engine left for a person to recover from (errored.tfstate, crash.log), encrypted in the vault: how many, and the hash of the encrypted record. Never their contents.
  recovery: optional({ files: count, sha256: hash }),
};

const RAW_KEY = /^(resource_changes|prior_state|planned_values|configuration|variables|outputs|before|after|state|values|plan|planFile|planJson|raw|stdout|stderr|output|credentials|secret|token)$/i;

function problemsOf(value: unknown, shape: Shape, path: string, out: string[]): void {
  if (typeof shape === "function") {
    if (!shape(value)) out.push(path + ": invalid value");
    return;
  }
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) { out.push(path + ": expected a list"); return; }
    value.forEach((item, i) => problemsOf(item, shape[0], path + "[" + i + "]", out));
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) { out.push(path + ": expected an object"); return; }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!Object.hasOwn(shape, key)) out.push(path + "." + key + (RAW_KEY.test(key) ? ": raw plan, state or output field" : ": not part of the evidence shape"));
    else problemsOf(record[key], shape[key], path + "." + key, out);
  }
  for (const key of Object.keys(shape)) {
    if (!Object.hasOwn(record, key) && !(typeof shape[key] === "object" && optionalShapes.has(shape[key] as object))) out.push(path + "." + key + ": missing");
  }
}

/** Every reason this document is not apply evidence. Empty means it is. */
export function applyEvidenceProblems(evidence: unknown): string[] {
  const problems: string[] = [];
  problemsOf(evidence, SHAPE, "evidence", problems);
  const record = evidence as Partial<ApplyEvidence> | null;
  if (problems.length === 0 && record?.approvals?.length === 0) problems.push("evidence.approvals: an apply records who approved it");
  return problems;
}

/** Throws unless the document is apply evidence. */
export function assertApplyEvidence(evidence: unknown): ApplyEvidence {
  const problems = applyEvidenceProblems(evidence);
  if (problems.length > 0) throw new Error("EVIDENCE_REJECTED:" + problems.slice(0, 8).join("; "));
  return evidence as ApplyEvidence;
}

/**
 * What a qualification record stands for. The operator's real-engine
 * qualification run produces it (the CLI qualify command writes it with
 * writeQualificationEvidence), and the record's `evidenceHash` is the hash of
 * this document in the vault. It is the same operator-held evidence key as every
 * other record: it proves the file was not edited, not that the operator is
 * independent of the machine (docs/act-pilot-apply.md). `realEngine` and
 * `backendIdentitySeparated` are the operator's attestations, not machine proof.
 */
export type QualificationEvidence = { [accountField: string]: unknown } & {
  schemaVersion: 1;
  engine: EngineId;
  /** The real engine binary ran the adapter's exact argument lists, not a fake. */
  realEngine: true;
  /** Backend access ran as the separate state identities, never the provider-apply identity. */
  backendIdentitySeparated: true;
  /** Besides the provider's account fields (the DEV account the qualification ran against; apply refuses any other): the DEV backend and workspace it ran against. */
  backend: string;
  workspace: string;
  /** The STATE_WRITE and APPLY principals (client ids, role ARNs) the operator attested from the cloud logs, trimmed and lowercase. */
  stateWriteClientId: string;
  applyClientId: string;
  /** SHA-256 of the engine binary that qualified; a different binary needs a new qualification. */
  terraformSha256: string;
  adapterVersion: string;
  argvDigest: string;
  engineVersion: string;
  qualifiedAt: string;
};

const qualificationShape = (spec: ProviderSpec): Shape => ({
  schemaVersion: oneOf(1),
  engine: oneOf(...ENGINE_IDS),
  realEngine: oneOf(true),
  backendIdentitySeparated: oneOf(true),
  ...Object.fromEntries(Object.entries(spec.accountFields).map(([field, ok]): [string, Check] => [field, (v) => typeof v === "string" && ok(v)])),
  backend: text,
  workspace: text,
  stateWriteClientId: (v) => typeof v === "string" && spec.clientIdOk(v),
  applyClientId: (v) => typeof v === "string" && spec.clientIdOk(v),
  terraformSha256: hash,
  adapterVersion: text,
  argvDigest: hash,
  engineVersion: text,
  qualifiedAt: iso,
});

/** Every reason this document is not qualification evidence. Empty means it is. */
export function qualificationEvidenceProblems(evidence: unknown, spec: ProviderSpec): string[] {
  const problems: string[] = [];
  problemsOf(evidence, qualificationShape(spec), "qualification", problems);
  const record = evidence as Partial<QualificationEvidence> | null;
  if (problems.length === 0 && record?.stateWriteClientId === record?.applyClientId) problems.push("qualification.applyClientId: STATE_WRITE and APPLY are separate principals");
  return problems;
}
