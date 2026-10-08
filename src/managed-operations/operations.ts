import { createHash } from "node:crypto";
import type { ChangeRequest, SovereignChangeRecord } from "../change-ledger/types.js";
import { LocalSovereignChangeLedger } from "../change-ledger/local.js";
import {
  DelegatedAgentAuthority, type DelegatedOperation, type LeaseRequest,
} from "../delegation/identity.js";

export type ManagedAction = Extract<DelegatedOperation, "RESTART_SERVICE" | "RECONCILE_SERVICE" | "RESTORE_SERVICE">;
export type DiagnosticAction = Extract<DelegatedOperation, "DIAGNOSTIC" | "VALIDATE" | "PREVIEW" | "RECOVERY_TEST">;
const ALLOWED: ManagedAction[] = ["RESTART_SERVICE", "RECONCILE_SERVICE", "RESTORE_SERVICE"];
const SAFE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/;
const EVIDENCE = /^evidence:\/\/[a-zA-Z0-9._/-]{1,128}$/;

export type OperationalPlaybookInput = {
  playbookId: string;
  version: string;
  operation: ManagedAction;
  providerId: string;
  environmentId: string;
  targetResourceId: string;
  preconditions: string[];
  maxTargets: 1;
  approvalMode: Exclude<ChangeRequest["approval"]["mode"], "ADVISORY">;
  verificationRequired: true;
  recovery: "REQUIRED" | "NOT_SUPPORTED";
  timeoutMs: number;
};
export type OperationalPlaybook = OperationalPlaybookInput & { artifactSha256: string };
export interface ManagedOperationsProvider {
  readonly id: string;
  readonly environmentId: string;
  /** Diagnostics and conditions must not mutate infrastructure. */
  inspect(input: { targetResourceId: string; requiredPreconditions: string[] }): Promise<{ satisfied: boolean; evidenceRefs: string[] }>;
  validate(input: { targetResourceId: string }): Promise<{ observed: boolean; evidenceRefs: string[] }>;
  preview(input: { operation: ManagedAction; targetResourceId: string }): Promise<{ possible: boolean; evidenceRefs: string[] }>;
  recoveryTest(input: { targetResourceId: string }): Promise<{ ready: boolean; evidenceRefs: string[] }>;
  /** Only named bounded methods, no CLI/shell/IaC execution path. */
  perform(input: { operation: ManagedAction; targetResourceId: string; changeRecordId: string; signal: AbortSignal }): Promise<{ ok: boolean; evidenceRefs: string[] }>;
  verify(input: { targetResourceId: string }): Promise<{ ok: boolean; evidenceRefs: string[] }>;
  recover(input: { targetResourceId: string; changeRecordId: string; signal: AbortSignal }): Promise<{ ok: boolean; evidenceRefs: string[] }>;
}
export type ManagedOperationResult = {
  changeRecordId: string;
  status: "SUCCEEDED" | "FAILED";
  verification: "PASS" | "FAIL" | "NOT_RUN";
  recovery: ChangeRequest["recovery"];
  record: SovereignChangeRecord;
  providerExecuted: true;
};
function fail(code: string): never { throw new Error("MANAGED_OPERATIONS_" + code); }
function id(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE.test(value)) return fail(field);
  return value;
}
function refs(input: string[]): string[] {
  if (!Array.isArray(input) || input.length > 100 || !input.every((r) => EVIDENCE.test(r) && !r.includes(".."))) fail("EVIDENCE_INVALID");
  return input;
}
function normalize(input: OperationalPlaybookInput): OperationalPlaybookInput {
  id(input.playbookId, "PLAYBOOK_ID_INVALID"); id(input.version, "VERSION_INVALID");
  id(input.providerId, "PROVIDER_ID_INVALID"); id(input.environmentId, "ENVIRONMENT_INVALID");
  id(input.targetResourceId, "TARGET_INVALID");
  if (!ALLOWED.includes(input.operation) || input.maxTargets !== 1 || input.verificationRequired !== true ||
    !["LOCAL", "STANDARD_PREAPPROVED", "NORMAL", "EMERGENCY"].includes(input.approvalMode) ||
    !["REQUIRED", "NOT_SUPPORTED"].includes(input.recovery) ||
    !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 10000 ||
    !Array.isArray(input.preconditions) || input.preconditions.length < 1 || input.preconditions.length > 20) fail("PLAYBOOK_UNBOUNDED");
  const preconditions = [...new Set(input.preconditions.map((value) => id(value, "PRECONDITION_INVALID")))].sort();
  return {
    playbookId: input.playbookId, version: input.version, operation: input.operation,
    providerId: input.providerId, environmentId: input.environmentId,
    targetResourceId: input.targetResourceId, preconditions, maxTargets: 1,
    approvalMode: input.approvalMode, verificationRequired: true, recovery: input.recovery,
    timeoutMs: input.timeoutMs,
  };
}
export function sealOperationalPlaybook(input: OperationalPlaybookInput): OperationalPlaybook {
  const normalized = normalize(input);
  return {
    ...normalized,
    artifactSha256: createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
  };
}
function verifyPlaybook(playbook: OperationalPlaybook): void {
  const sealed = sealOperationalPlaybook(playbook);
  if (JSON.stringify(sealed) !== JSON.stringify(playbook)) fail("PLAYBOOK_INTEGRITY_DENIED");
}
function currentRecord(ledger: LocalSovereignChangeLedger, changeRecordId: string): SovereignChangeRecord {
  const current = ledger.readVerified().filter((r) => r.changeRecordId === changeRecordId).at(-1);
  if (!current || !["REQUESTED", "RECONCILED"].includes(current.phase)) fail("CHANGE_RECORD_UNAVAILABLE");
  return current;
}
function validChange(record: SovereignChangeRecord, p: OperationalPlaybook, req: LeaseRequest): void {
  if (record.authorityClass !== "OPERATE" || record.changeRecordId === "" || record.actionType !== p.operation ||
    record.environmentId !== p.environmentId || record.substrate !== p.providerId ||
    record.resourceIds.length !== 1 || record.resourceIds[0] !== p.targetResourceId ||
    record.maxTargets !== p.maxTargets || record.approval.mode !== p.approvalMode ||
    record.approval.state !== "APPROVED" || !record.approval.reference ||
    record.playbook.id !== p.playbookId || record.playbook.version !== p.version ||
    record.playbook.sha256 !== p.artifactSha256 ||
    JSON.stringify([...record.preconditions].sort()) !== JSON.stringify(p.preconditions) ||
    record.agentActorId !== req.agent.agentId ||
    req.taskId !== record.actionId || req.environmentId !== p.environmentId ||
    req.resourceId !== p.targetResourceId || req.operation !== p.operation) {
      fail("CHANGE_APPROVAL_SCOPE_DENIED");
  }
  // Authenticated identity checks below bind the real human subject to the recorded requestor.
}
async function limited<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let handle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<T>((_, reject) => {
        handle = setTimeout(() => {
          controller.abort();
          reject(new Error("MANAGED_OPERATIONS_PROVIDER_TIMEOUT"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (handle) clearTimeout(handle);
  }
}
export class ManagedOperationsCoordinator {
  constructor(
    private readonly ledger: LocalSovereignChangeLedger,
    private readonly delegatedAuthority: DelegatedAgentAuthority,
    private readonly provider: ManagedOperationsProvider,
  ) {}
  async diagnose(action: DiagnosticAction, targetResourceId: string): Promise<{ possible: boolean; evidenceRefs: string[] }> {
    id(targetResourceId, "TARGET_INVALID");
    if (action === "DIAGNOSTIC") {
      const result = await this.provider.inspect({ targetResourceId, requiredPreconditions: [] });
      return { possible: result.satisfied, evidenceRefs: refs(result.evidenceRefs) };
    }
    if (action === "VALIDATE") {
      const result = await this.provider.validate({ targetResourceId });
      return { possible: result.observed, evidenceRefs: refs(result.evidenceRefs) };
    }
    if (action === "RECOVERY_TEST") {
      const result = await this.provider.recoveryTest({ targetResourceId });
      return { possible: result.ready, evidenceRefs: refs(result.evidenceRefs) };
    }
    if (action !== "PREVIEW") fail("DIAGNOSTIC_ACTION_UNSUPPORTED");
    // Preview may list named actions, but cannot mutate.
    const result = await this.provider.preview({ operation: "RESTART_SERVICE", targetResourceId });
    return { possible: result.possible, evidenceRefs: refs(result.evidenceRefs) };
  }
  async operate(input: {
    changeRecordId: string;
    playbook: OperationalPlaybook;
    leaseRequest: LeaseRequest;
    at?: string;
  }): Promise<ManagedOperationResult> {
    const p = input.playbook;
    verifyPlaybook(p);
    if (this.provider.id !== p.providerId || this.provider.environmentId !== p.environmentId) fail("PROVIDER_SCOPE_DENIED");
    id(input.changeRecordId, "CHANGE_RECORD_ID_INVALID");
    const record = currentRecord(this.ledger, input.changeRecordId);
    validChange(record, p, input.leaseRequest);
    const first = await this.provider.inspect({ targetResourceId: p.targetResourceId, requiredPreconditions: p.preconditions });
    refs(first.evidenceRefs);
    if (!first.satisfied) fail("PRECONDITIONS_DENIED");
    // Local canonical change record already exists before capability issuance.
    const lease = await this.delegatedAuthority.issue(input.leaseRequest);
    if (lease.humanSubjectId !== record.requestorId) fail("CHANGE_REQUESTOR_MISMATCH");
    const consumed = await this.delegatedAuthority.consume({ ...input.leaseRequest, leaseId: lease.leaseId });
    const second = await this.provider.inspect({ targetResourceId: p.targetResourceId, requiredPreconditions: p.preconditions });
    refs(second.evidenceRefs);
    if (!second.satisfied) fail("PRECONDITIONS_DENIED");
    const startedAt = input.at ?? new Date().toISOString();
    // Start revision is fsynced before calling a mutating provider; concurrent execution attempts cannot reuse this record.
    this.ledger.markStarted(input.changeRecordId, consumed.leaseId, consumed.policyDecisionId, startedAt, record.recordHash);
    let status: ManagedOperationResult["status"] = "FAILED";
    let verification: ManagedOperationResult["verification"] = "NOT_RUN";
    let recovery: ManagedOperationResult["recovery"] = "NOT_REQUIRED";
    const evidence = [...first.evidenceRefs, ...second.evidenceRefs];
    let performed = false;
    try {
      const act = await limited((signal) => this.provider.perform({
        operation: p.operation, targetResourceId: p.targetResourceId,
        changeRecordId: input.changeRecordId, signal,
      }), p.timeoutMs);
      performed = true;
      evidence.push(...refs(act.evidenceRefs));
      if (act.ok) {
        const checked = await limited(() => this.provider.verify({ targetResourceId: p.targetResourceId }), p.timeoutMs);
        evidence.push(...refs(checked.evidenceRefs));
        verification = checked.ok ? "PASS" : "FAIL";
        status = checked.ok ? "SUCCEEDED" : "FAILED";
      }
    } catch {
      status = "FAILED";
    }
    if (status !== "SUCCEEDED" && p.recovery === "REQUIRED") {
      try {
        const restored = await limited((signal) => this.provider.recover({
          targetResourceId: p.targetResourceId, changeRecordId: input.changeRecordId, signal,
        }), p.timeoutMs);
        evidence.push(...refs(restored.evidenceRefs));
        recovery = restored.ok ? "SUCCEEDED" : "FAILED";
      } catch {
        recovery = "FAILED";
      }
    } else if (status !== "SUCCEEDED") {
      recovery = p.recovery === "NOT_SUPPORTED" ? "NOT_REQUIRED" : "NOT_RUN";
    }
    if (!performed && status === "FAILED" && verification === "NOT_RUN") {
      // An aborted/unknown provider response may have changed state; mark FAILED and preserve recovery evidence.
      evidence.push("evidence://operations/unknown-execution");
    }
    const outcome = this.ledger.recordOutcome(input.changeRecordId, {
      status, verification, recovery, evidenceRefs: refs(evidence),
    }, new Date().toISOString());
    return {
      changeRecordId: input.changeRecordId, status, verification, recovery,
      record: outcome, providerExecuted: true,
    };
  }
}
