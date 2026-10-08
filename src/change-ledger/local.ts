import { createHash, sign, verify, type KeyLike } from "node:crypto";
import {
  closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, unlinkSync, writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type {
  ChangeReference, ChangeRequest, LedgerAnchorPayload, LedgerVerification,
  SignedLedgerExport, SovereignChangeRecord,
} from "./types.js";

const SAFE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const SAFE_SHA = /^[a-f0-9]{64}$/;
const EVIDENCE = /^evidence:\/\/[a-zA-Z0-9._/-]{1,128}$/;
const SYSTEMS = new Set(["JIRA", "SERVICENOW", "CMDB", "GITHUB", "GITLAB", "JENKINS", "CIRCLECI"]);
const MAX_LOG_BYTES = 16_000_000;
const MAX_ENTRIES = 20000;

function fail(code: string): never { throw new Error("SOVEREIGN_LEDGER_" + code); }
function validId(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE.test(value) || value.includes("..")) return fail(field);
  return value;
}
function validEvidence(value: unknown): string {
  if (typeof value !== "string" || !EVIDENCE.test(value) || value.includes("..")) return fail("EVIDENCE_REF_INVALID");
  return value;
}
function validTime(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) return fail(field);
  return value;
}
function validRefs(value: unknown): ChangeReference[] {
  if (!Array.isArray(value) || value.length > 30) return fail("EXTERNAL_REFERENCES_INVALID");
  return value.map((r) => {
    if (!r || typeof r !== "object" || !SYSTEMS.has(r.system)) return fail("EXTERNAL_SYSTEM_INVALID");
    return { system: r.system as ChangeReference["system"], recordId: validId(r.recordId, "EXTERNAL_REFERENCE_INVALID") };
  });
}
function stringIds(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) return fail(field);
  return value.map((v) => validId(v, field));
}
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function expectedHash(record: SovereignChangeRecord): string {
  const { recordHash: ignored, ...unsigned } = record;
  void ignored;
  return "sha256:" + sha256(JSON.stringify(unsigned));
}
function sourceValid(input: ChangeRequest): ChangeRequest {
  const basic = ["changeRecordId", "actionId", "actionType", "environmentId", "substrate", "requestorId"] as const;
  for (const key of basic) validId(input[key], key);
  if (!["ADVISE", "OPERATE"].includes(input.authorityClass)) fail("AUTHORITY_CLASS_INVALID");
  if (!["DISCONNECTED", "CONNECTED"].includes(input.mode)) fail("MODE_INVALID");
  if (!input.approval || !["ADVISORY", "LOCAL", "STANDARD_PREAPPROVED", "NORMAL", "EMERGENCY"].includes(input.approval.mode) ||
    !["NOT_REQUIRED", "PENDING", "APPROVED", "DENIED"].includes(input.approval.state)) fail("APPROVAL_INVALID");
  if (input.approval.reference !== undefined) validId(input.approval.reference, "APPROVAL_REFERENCE_INVALID");
  if (input.policyDecisionId !== undefined) validId(input.policyDecisionId, "POLICY_DECISION_INVALID");
  if (input.capabilityLeaseId !== undefined) validId(input.capabilityLeaseId, "LEASE_ID_INVALID");
  if (input.agentActorId !== undefined) validId(input.agentActorId, "AGENT_ID_INVALID");
  if (input.initiatingRef !== undefined) validId(input.initiatingRef, "INITIATING_REF_INVALID");
  if (!input.playbook || !SAFE_SHA.test(input.playbook.sha256)) fail("PLAYBOOK_HASH_INVALID");
  validId(input.playbook.id, "PLAYBOOK_ID_INVALID");
  validId(input.playbook.version, "PLAYBOOK_VERSION_INVALID");
  const resourceIds = stringIds(input.resourceIds, "RESOURCE_SCOPE_INVALID", 100);
  const preconditions = stringIds(input.preconditions, "PRECONDITIONS_INVALID", 50);
  const relatedChangeRecordIds = stringIds(input.relatedChangeRecordIds, "RELATED_RECORDS_INVALID", 50);
  if (!Number.isSafeInteger(input.maxTargets) || input.maxTargets < 1 || input.maxTargets > 100 ||
    resourceIds.length > input.maxTargets || resourceIds.length === 0) fail("BLAST_RADIUS_INVALID");
  if (!input.execution || !["NOT_EXECUTED", "SUCCEEDED", "FAILED"].includes(input.execution.status)) fail("EXECUTION_INVALID");
  if (input.execution.startedAt) validTime(input.execution.startedAt, "EXECUTION_STARTED_AT_INVALID");
  if (input.execution.finishedAt) validTime(input.execution.finishedAt, "EXECUTION_FINISHED_AT_INVALID");
  if (!["NOT_RUN", "PASS", "FAIL"].includes(input.verification) ||
    !["NOT_REQUIRED", "NOT_RUN", "SUCCEEDED", "FAILED"].includes(input.recovery)) fail("VERIFICATION_INVALID");
  if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length > 200) fail("EVIDENCE_REFS_INVALID");
  const evidenceRefs = input.evidenceRefs.map(validEvidence);
  const externalRefs = validRefs(input.externalRefs);
  if (input.mode === "DISCONNECTED" && externalRefs.length) fail("DISCONNECTED_CANNOT_BIND_EXTERNAL");
  if (input.mode === "CONNECTED" && !externalRefs.some((r) => r.system === "JIRA" || r.system === "SERVICENOW")) fail("CONNECTED_ITSM_REFERENCE_REQUIRED");
  if (input.execution.status !== "NOT_EXECUTED" || input.verification !== "NOT_RUN") fail("INITIAL_RECORD_MUST_NOT_CLAIM_EXECUTION");
  return {
    changeRecordId: input.changeRecordId, actionId: input.actionId, actionType: input.actionType,
    authorityClass: input.authorityClass, environmentId: input.environmentId,
    substrate: input.substrate, resourceIds, ...(input.initiatingRef ? { initiatingRef: input.initiatingRef } : {}),
    requestorId: input.requestorId, ...(input.agentActorId ? { agentActorId: input.agentActorId } : {}),
    approval: { mode: input.approval.mode, state: input.approval.state, ...(input.approval.reference ? { reference: input.approval.reference } : {}) },
    ...(input.policyDecisionId ? { policyDecisionId: input.policyDecisionId } : {}),
    ...(input.capabilityLeaseId ? { capabilityLeaseId: input.capabilityLeaseId } : {}),
    playbook: { id: input.playbook.id, version: input.playbook.version, sha256: input.playbook.sha256 },
    preconditions, maxTargets: input.maxTargets, execution: { status: "NOT_EXECUTED" },
    verification: "NOT_RUN", recovery: input.recovery, evidenceRefs, relatedChangeRecordIds,
    mode: input.mode, externalRefs,
  };
}

function verifyRecords(records: SovereignChangeRecord[]): LedgerVerification {
  if (records.length > MAX_ENTRIES) fail("ENTRY_LIMIT");
  let previous: string | null = null;
  const latest = new Map<string, SovereignChangeRecord>();
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    if (r.schemaVersion !== 1 || r.sequence !== i + 1 || r.previousRecordHash !== previous ||
      r.actAuthorizedByLedger !== false || r.recordHash !== expectedHash(r)) fail("INTEGRITY_FAILED");
    validTime(r.at, "RECORD_TIMESTAMP_INVALID");
    if (!r.changeRecordId || !SAFE.test(r.changeRecordId)) fail("RECORD_ID_INVALID");
    const prior = latest.get(r.changeRecordId);
    if (prior) {
      if (r.phase !== "RECONCILED" || r.mode !== "RECONCILED" || r.revision !== prior.revision + 1 ||
        r.supersedesRecordHash !== prior.recordHash || r.execution.status !== prior.execution.status ||
        r.authorityClass !== prior.authorityClass) fail("REVISION_LINEAGE_INVALID");
    } else if (r.revision !== 1 || r.phase !== "REQUESTED" || r.mode === "RECONCILED" || r.supersedesRecordHash !== null) {
      fail("INITIAL_LINEAGE_INVALID");
    }
    latest.set(r.changeRecordId, r);
    previous = r.recordHash;
  }
  return { valid: true, count: records.length, headHash: previous };
}

/** Metadata-only append-only local ledger. Encryption at rest is supplied by customer-controlled storage. */
export class LocalSovereignChangeLedger {
  private readonly directory: string;
  private readonly file: string;
  constructor(directory: string) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.file = join(this.directory, "sovereign-changes.ndjson");
  }
  readVerified(): SovereignChangeRecord[] {
    if (!existsSync(this.file)) return [];
    const stat = lstatSync(this.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_LOG_BYTES) fail("FILE_UNSAFE");
    const raw = readFileSync(this.file, "utf8");
    if (raw && !raw.endsWith("\n")) fail("PARTIAL_WRITE");
    let records: SovereignChangeRecord[];
    try { records = raw.trim() ? raw.trimEnd().split("\n").map((line) => JSON.parse(line) as SovereignChangeRecord) : []; }
    catch { return fail("PARSE_FAILED"); }
    verifyRecords(records);
    return records;
  }
  verify(): LedgerVerification { return verifyRecords(this.readVerified()); }
  private commit(builder: (records: SovereignChangeRecord[]) => SovereignChangeRecord): SovereignChangeRecord {
    const lock = join(this.directory, ".sovereign-ledger.lock");
    let lockFd: number;
    try { lockFd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
    catch { return fail("WRITE_LOCK_UNAVAILABLE"); }
    try {
      const history = this.readVerified();
      const record = builder(history);
      if (record.recordHash !== expectedHash(record)) fail("CANDIDATE_HASH_INVALID");
      verifyRecords([...history, record]);
      const fd = openSync(this.file, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        const bytes = Buffer.from(JSON.stringify(record) + "\n", "utf8");
        let offset = 0;
        while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
        fsyncSync(fd);
      } finally { closeSync(fd); }
      return record;
    } finally { closeSync(lockFd); unlinkSync(lock); }
  }
  create(input: ChangeRequest, at: string): SovereignChangeRecord {
    const sanitized = sourceValid(input);
    validTime(at, "RECORD_TIMESTAMP_INVALID");
    return this.commit((history) => {
      if (history.some((r) => r.changeRecordId === sanitized.changeRecordId)) fail("DUPLICATE_CANONICAL_ID");
      const record: SovereignChangeRecord = {
        ...sanitized, schemaVersion: 1, revision: 1, phase: "REQUESTED", at,
        sequence: history.length + 1, previousRecordHash: history.at(-1)?.recordHash ?? null,
        supersedesRecordHash: null, recordHash: "", actAuthorizedByLedger: false,
      };
      record.recordHash = expectedHash(record);
      return record;
    });
  }
  reconcile(changeRecordId: string, externalRefs: ChangeReference[], at: string): SovereignChangeRecord {
    validId(changeRecordId, "RECONCILE_ID_INVALID");
    validTime(at, "RECORD_TIMESTAMP_INVALID");
    const refs = validRefs(externalRefs);
    if (!refs.some((r) => r.system === "JIRA" || r.system === "SERVICENOW")) fail("RECONCILE_ITSM_REFERENCE_REQUIRED");
    return this.commit((history) => {
      const original = history.find((r) => r.changeRecordId === changeRecordId);
      const previous = [...history].reverse().find((r) => r.changeRecordId === changeRecordId);
      if (!original || !previous || original.mode !== "DISCONNECTED") fail("RECONCILE_SOURCE_NOT_FOUND");
      const combined = [...previous.externalRefs, ...refs];
      const distinct = [...new Map(combined.map((ref) => [ref.system + ":" + ref.recordId, ref])).values()];
      const record: SovereignChangeRecord = {
        ...previous, mode: "RECONCILED", phase: "RECONCILED", revision: previous.revision + 1,
        at, sequence: history.length + 1, externalRefs: distinct,
        previousRecordHash: history.at(-1)?.recordHash ?? null,
        supersedesRecordHash: previous.recordHash, recordHash: "", actAuthorizedByLedger: false,
      };
      record.recordHash = expectedHash(record);
      return record;
    });
  }
  signedExport(privateKey: KeyLike): SignedLedgerExport {
    const records = this.readVerified();
    const current = verifyRecords(records);
    const payload: LedgerAnchorPayload = {
      schemaVersion: 1, source: "SOVEREIGN_LOCAL_CHANGE_LEDGER",
      headHash: current.headHash, count: current.count, records,
      evidenceRefs: [...new Set(records.flatMap((r) => r.evidenceRefs))].sort(),
    };
    return {
      payload, signatureAlgorithm: "Ed25519",
      signatureBase64: sign(null, Buffer.from(JSON.stringify(payload), "utf8"), privateKey).toString("base64"),
    };
  }
}
export function verifySignedLedgerExport(input: SignedLedgerExport, trustedPublicKey: KeyLike): LedgerVerification {
  if (input.signatureAlgorithm !== "Ed25519" || !Array.isArray(input.payload?.records) ||
    input.payload.schemaVersion !== 1 || input.payload.source !== "SOVEREIGN_LOCAL_CHANGE_LEDGER") fail("EXPORT_SCHEMA_INVALID");
  let ok = false;
  try { ok = verify(null, Buffer.from(JSON.stringify(input.payload), "utf8"), trustedPublicKey, Buffer.from(input.signatureBase64, "base64")); }
  catch { ok = false; }
  if (!ok) fail("EXPORT_SIGNATURE_INVALID");
  const status = verifyRecords(input.payload.records);
  if (input.payload.headHash !== status.headHash || input.payload.count !== status.count) fail("EXPORT_ANCHOR_INVALID");
  const refs = [...new Set(input.payload.records.flatMap((r) => r.evidenceRefs))].sort();
  if (JSON.stringify(refs) !== JSON.stringify(input.payload.evidenceRefs)) fail("EXPORT_EVIDENCE_MANIFEST_INVALID");
  return status;
}
