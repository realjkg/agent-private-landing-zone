import { randomUUID } from "node:crypto";
import { evaluateBuiltinSecurityPolicy } from "../security/policy/builtin.js";
import type { CompromiseState } from "../security/policy/types.js";

export type DelegatedOperation =
  | "DISCOVER" | "DIAGNOSTIC" | "VALIDATE" | "PREVIEW" | "RECOVERY_TEST"
  | "RESTART_SERVICE" | "RECONCILE_SERVICE" | "RESTORE_SERVICE";
const OPERATIONS: readonly DelegatedOperation[] = [
  "DISCOVER", "DIAGNOSTIC", "VALIDATE", "PREVIEW", "RECOVERY_TEST",
  "RESTART_SERVICE", "RECONCILE_SERVICE", "RESTORE_SERVICE",
];
const READ_ONLY = new Set<DelegatedOperation>(["DISCOVER","DIAGNOSTIC","VALIDATE","PREVIEW","RECOVERY_TEST"]);
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/;

export type HumanIdentityAttestation = {
  subjectId: string;
  sessionRef: string;
  mfaAssurance: "NONE" | "AAL1" | "AAL2" | "AAL3";
  mfaVerifiedAt: string;
  verified: boolean;
};
export type AgentActor = { agentId: string; harnessId: string };
export type OperationEntitlement = {
  roleId: string;
  operation: DelegatedOperation;
  environmentId: string;
  resourceId: string;
};
export interface HumanIdentityProvider {
  /** Must verify the session and MFA server-side, not trust fields supplied by the model. */
  verifySession(sessionRef: string): Promise<HumanIdentityAttestation | null>;
}
export interface EntitlementProvider {
  /** Pull from the authoritative RBAC source rather than agent claims. */
  forSubject(subjectId: string): Promise<OperationEntitlement[]>;
}
export interface DeterministicDelegationPolicy {
  evaluate(input: {
    subjectId: string;
    agentId: string;
    taskId: string;
    environmentId: string;
    resourceId: string;
    operation: DelegatedOperation;
  }): Promise<{ allow: boolean; decisionId?: string }>;
}
export type LeaseRequest = {
  sessionRef: string;
  agent: AgentActor;
  taskId: string;
  environmentId: string;
  resourceId: string;
  operation: DelegatedOperation;
  ttlSeconds: number;
  maxExecutions: number;
};
export type DelegationLease = {
  leaseId: string;
  humanSubjectId: string;
  agentActorId: string;
  harnessId: string;
  taskId: string;
  environmentId: string;
  resourceId: string;
  operation: DelegatedOperation;
  issuedAt: string;
  expiresAt: string;
  maxExecutions: number;
  executions: number;
  policyDecisionId: string;
  revocable: true;
};
type PrivateLease = {
  public: DelegationLease;
  sessionRef: string;
  revoked: boolean;
};
function fail(code: string): never { throw new Error("DELEGATION_" + code); }
function id(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) return fail("IDENTIFIER_INVALID");
  return value;
}
function operation(value: unknown): DelegatedOperation {
  if (!OPERATIONS.includes(value as DelegatedOperation)) return fail("OPERATION_FORBIDDEN");
  return value as DelegatedOperation;
}
function validMfa(subject: HumanIdentityAttestation | null, now: number, forMutation: boolean): subject is HumanIdentityAttestation {
  if (!subject?.verified || !(forMutation ? subject.mfaAssurance === "AAL3" : ["AAL2","AAL3"].includes(subject.mfaAssurance))) return false;
  const verifiedAt = Date.parse(subject.mfaVerifiedAt);
  return Number.isFinite(verifiedAt) && verifiedAt <= now && now - verifiedAt <= 5 * 60 * 1000;
}
export class DelegatedAgentAuthority {
  private readonly leases = new Map<string, PrivateLease>();
  constructor(
    private readonly identity: HumanIdentityProvider,
    private readonly entitlements: EntitlementProvider,
    private readonly policy: DeterministicDelegationPolicy,
    private readonly compromiseState: () => CompromiseState,
    private readonly clock: () => number = Date.now,
  ) {}
  private async authorize(input: {
    sessionRef: string; agent: AgentActor; taskId: string; environmentId: string; resourceId: string; operation: DelegatedOperation;
    expectedSubject?: string;
  }): Promise<{ subjectId: string; decisionId: string }> {
    id(input.sessionRef);
    id(input.agent.agentId); id(input.agent.harnessId);
    id(input.taskId); id(input.environmentId); id(input.resourceId);
    operation(input.operation);
    const now = this.clock();
    let subject: HumanIdentityAttestation | null;
    try { subject = await this.identity.verifySession(input.sessionRef); }
    catch { return fail("IDENTITY_UNAVAILABLE"); }
    if (!subject || subject.sessionRef !== input.sessionRef || !validMfa(subject, now, !READ_ONLY.has(input.operation))) fail("HUMAN_MFA_REQUIRED");
    id(subject.subjectId);
    if (subject.subjectId === input.agent.agentId || subject.subjectId === input.agent.harnessId) fail("ACTOR_SEPARATION_REQUIRED");
    if (input.expectedSubject && input.expectedSubject !== subject.subjectId) fail("SPONSOR_MISMATCH");
    let roles: OperationEntitlement[];
    try { roles = await this.entitlements.forSubject(subject.subjectId); }
    catch { return fail("RBAC_UNAVAILABLE"); }
    if (!roles.some((r) =>
      r.operation === input.operation && r.environmentId === input.environmentId &&
      r.resourceId === input.resourceId && IDENTIFIER.test(r.roleId)
    )) fail("RBAC_DENIED");
    const posture = evaluateBuiltinSecurityPolicy({
      kind: "CAPABILITY", compromiseState: this.compromiseState(),
      requested: [READ_ONLY.has(input.operation) ? "EVIDENCE_READ" : "MANAGED_ACCESS"],
    });
    if (!posture.allow) fail("SECURITY_POLICY_DENIED");
    let decision: { allow: boolean; decisionId?: string };
    try {
      decision = await this.policy.evaluate({
        subjectId: subject.subjectId, agentId: input.agent.agentId,
        taskId: input.taskId, environmentId: input.environmentId,
        resourceId: input.resourceId, operation: input.operation,
      });
    } catch { return fail("DETERMINISTIC_POLICY_UNAVAILABLE"); }
    if (!decision?.allow || typeof decision.decisionId !== "string" || !IDENTIFIER.test(decision.decisionId)) fail("DETERMINISTIC_POLICY_DENIED");
    return { subjectId: subject.subjectId, decisionId: decision.decisionId };
  }
  async issue(request: LeaseRequest): Promise<DelegationLease> {
    if (!Number.isSafeInteger(request.ttlSeconds) || request.ttlSeconds < 1 || request.ttlSeconds > 600 ||
      !Number.isSafeInteger(request.maxExecutions) || request.maxExecutions < 1 || request.maxExecutions > 5) {
      fail("LEASE_BOUNDS_INVALID");
    }
    const result = await this.authorize({ ...request });
    const now = this.clock();
    const lease: DelegationLease = {
      leaseId: "delegation-" + randomUUID(), humanSubjectId: result.subjectId,
      agentActorId: request.agent.agentId, harnessId: request.agent.harnessId,
      taskId: request.taskId, environmentId: request.environmentId, resourceId: request.resourceId,
      operation: request.operation, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + request.ttlSeconds * 1000).toISOString(),
      maxExecutions: request.maxExecutions, executions: 0, policyDecisionId: result.decisionId, revocable: true,
    };
    this.leases.set(lease.leaseId, { public: lease, sessionRef: request.sessionRef, revoked: false });
    return { ...lease };
  }
  async consume(input: {
    leaseId: string; sessionRef: string; agent: AgentActor; taskId: string;
    environmentId: string; resourceId: string; operation: DelegatedOperation;
  }): Promise<DelegationLease> {
    const stored = this.leases.get(input.leaseId);
    if (!stored || stored.revoked) fail("LEASE_NOT_ACTIVE");
    const lease = stored.public;
    if (input.sessionRef !== stored.sessionRef || input.agent.agentId !== lease.agentActorId ||
      input.agent.harnessId !== lease.harnessId || input.taskId !== lease.taskId ||
      input.environmentId !== lease.environmentId || input.resourceId !== lease.resourceId ||
      input.operation !== lease.operation) fail("LEASE_SCOPE_DENIED");
    if (this.clock() >= Date.parse(lease.expiresAt)) fail("LEASE_EXPIRED");
    if (lease.executions >= lease.maxExecutions) fail("LEASE_EXHAUSTED");
    // Recheck human sponsorship, current entitlement and sovereign policy immediately before every use.
    const result = await this.authorize({ ...input, expectedSubject: lease.humanSubjectId });
    if (this.clock() >= Date.parse(lease.expiresAt)) fail("LEASE_EXPIRED");
    if (stored.revoked || lease.executions >= lease.maxExecutions) fail("LEASE_NOT_ACTIVE");
    lease.executions++;
    lease.policyDecisionId = result.decisionId;
    return { ...lease };
  }
  revoke(leaseId: string): boolean {
    const lease = this.leases.get(leaseId);
    if (!lease) return false;
    lease.revoked = true;
    return true;
  }
  inspect(leaseId: string): (DelegationLease & { active: boolean }) | null {
    const stored = this.leases.get(leaseId);
    if (!stored) return null;
    return {
      ...stored.public,
      active: !stored.revoked && stored.public.executions < stored.public.maxExecutions &&
        this.clock() < Date.parse(stored.public.expiresAt),
    };
  }
}
