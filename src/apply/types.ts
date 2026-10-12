import type { ResolvedTarget } from "../teardown/driver/types.js";
import type { ExecutionIdentity } from "../tools/identity.js";
import type { AwsTarget } from "./providers/aws.js";
import type { AzureTarget } from "./providers/azure.js";

/**
 * The pilot apply contract (docs/act-pilot-plan.md).
 *
 * The operator authorizes, the driver enforces, and agents never initiate an
 * apply. Everything here is human-invoked: nothing under src/apply is reachable
 * from src/tools, src/operator-ui or any agent path, and the console only shows
 * the command. ACT stays DISABLED unless a valid pilot contract enables it.
 */
/** Promotion runs DEV, then QA, then PROD: each stage needs a successful apply of the same release in the stage before it. */
export type ApplyEnvironment = "DEV" | "QA" | "PROD";

/**
 * Principals, never substituted for one another and never the operator's own credentials. An engine names the ones it
 * needs (`EngineSpec.identities`); these four are Terraform's. CHANGESET
 * (`tools/identity.ts`) is the CDK engine's fifth.
 */
export const APPLY_IDENTITIES = ["DISCOVERY", "STATE", "STATE_WRITE", "APPLY"] as const;
export type ApplyIdentity = ExecutionIdentity;

/** The engines the pilot has a spec for (src/apply/engine-spec.ts). The contract's `engine` selects one; anything else is not a contract. */
export type EngineId = "TERRAFORM" | "CDK";

/** The providers the pilot has a spec for (src/apply/provider.ts). The contract's `provider` selects one; anything else is not a contract. */
export type ProviderId = "AZURE" | "AWS";

/** One environment's exact target, in the shape the contract's provider defines. Real values come from the owner; tests use explicit fixtures. */
export type PilotTarget = AzureTarget | AwsTarget;

export type PilotContract = {
  schemaVersion: 1;
  /** ACT is off unless this is exactly true. A missing or malformed contract is off. */
  enabled: boolean;
  provider: ProviderId;
  engine: EngineId;
  targets: Record<ApplyEnvironment, PilotTarget>;
  /** Distinct verified approvals required per environment. DEV and QA at least 1, PROD at least 2. */
  requiredApprovals: Record<ApplyEnvironment, number>;
  maxApprovalAgeMinutes: number;
  /** The approver allowlist lives in the reviewed contract, never in an operator-supplied file. Ids and public keys are unique. */
  approvers: ApproverEntry[];
  /** Existence of this file stops an apply before it starts and between steps. */
  killSwitchPath: string;
  /**
   * Opt-in, default off (absent or false is today's behavior, byte for byte). Terraform engine only. When true, the seal-time `init`
   * embeds STATE_WRITE's non-secret backend settings, so the plan names the state writer (docs/act-pilot-apply.md, "Embedding STATE_WRITE
   * in the plan"). It is part of the pinned contract, so the sealed plan binds the choice through `contractSha256`.
   */
  embedStateWrite?: boolean;
};

/** The allowlist of people who may approve. A typed name is never proof; a verified signature is. */
export type ApproverEntry = { id: string; publicKeyPem: string; environments: ApplyEnvironment[] };

/** What an approver signs. It binds one approval to one artifact, one target and one moment. */
export type ApprovalStatement = {
  schemaVersion: 1;
  artifactSha256: string;
  environment: ApplyEnvironment;
  target: ResolvedTarget;
  approverId: string;
  issuedAt: string;
  expiresAt: string;
  /** 128-bit random value, consumed once. */
  nonce: string;
};
export type SignedApproval = { statement: ApprovalStatement; signatureBase64: string };

/**
 * The exact reviewed plan. The plan file is encrypted at rest and its hash is
 * part of the artifact identity, so the artifact an approver signs is the
 * artifact the driver applies.
 */
export type SealedPlan = {
  schemaVersion: 1;
  artifactSha256: string;
  planSha256: string;
  manifestHash: string;
  /** Target-independent identity of the qualified release: project files, lock file, engine and provider versions, shared inputs. Production promotes this, never a dev plan or dev manifest hash. */
  releaseIdentity: string;
  environment: ApplyEnvironment;
  target: ResolvedTarget;
  engineVersion: string;
  policyVersion: string;
  /** The pinned pilot contract (its canonical sha256) the plan was sealed under: it fixes the provider and every account field, region and tenant included, and the approver allowlist. An apply under another contract is refused. */
  contractSha256: string;
  createdAt: string;
  /** Normalized, redacted change summary: address, type, action, and what else an approver must see (an import, a move, a forget, an output change). Never plan values. */
  changes: PlanChange[];
};

/**
 * One line of the change list. `FORGET` removes a resource from state and leaves the real one; an output change is a
 * line with address `output.<name>` and type `output`; `importing` and `previousAddress` (a move) are set only when the
 * plan says so. Addresses never carry bidi or zero-width control characters (see `stripInvisible`).
 */
export type PlanChange = { address: string; type: string; action: string; importing?: true; previousAddress?: string };

export type ApplyRefusalCode =
  | "ACT_DISABLED"
  | "CONTRACT_INVALID"
  | "IDENTITY_TARGET_MISMATCH"
  | "KILL_SWITCH_ACTIVE"
  /** The kill switch appeared after the approvals were consumed and before the engine started: nothing applied, the approvals are spent. */
  | "KILL_SWITCH_AFTER_APPROVALS"
  | "HUMAN_INVOCATION_REQUIRED"
  | "TARGET_NOT_IN_CONTRACT"
  | "ARTIFACT_INVALID"
  | "ARTIFACT_TAMPERED"
  | "APPROVAL_INSUFFICIENT"
  | "APPROVAL_UNVERIFIED"
  | "APPROVER_NOT_ALLOWED"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_REPLAYED"
  | "APPROVAL_MISBOUND"
  | "SAME_APPROVER_TWICE"
  | "ARTIFACT_ALREADY_APPLIED"
  | "ENGINE_NOT_QUALIFIED"
  | "PROMOTION_EVIDENCE_MISSING"
  | "IDENTITY_NOT_CONFIGURED"
  | "IDENTITY_COLLAPSED"
  | "PLAN_STALE"
  | "APPLY_FAILED"
  /** The approvals were consumed and the engine did not start (a plan write, spawn or preparation failure): nothing ran, the approvals are spent. */
  | "APPROVALS_SPENT"
  | "EVIDENCE_REJECTED";

export type ApplyOutcome = "SUCCEEDED" | "FAILED_NO_CHANGE" | "PARTIAL_REQUIRES_REVIEW" | "KILLED";

/** Encrypted at rest. Never carries plan values, state, or raw engine output. */
export type ApplyEvidence = {
  schemaVersion: 1;
  environment: ApplyEnvironment;
  target: ResolvedTarget;
  artifactSha256: string;
  manifestHash: string;
  releaseIdentity: string;
  /** The pinned contract the apply ran under, and so the provider, account, region or tenant it ran against. */
  contractSha256: string;
  approvals: { approverId: string; issuedAt: string }[];
  adapter: { adapterVersion: string; argvDigest: string };
  toolVersions: { engine: string };
  outcome: ApplyOutcome;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string;
  authority: {
    infrastructureAct: "PILOT_ENABLED";
    /** What the engine did: Terraform applied the sealed plan, or CloudFormation executed the sealed change set. */
    mutation: "TERRAFORM_APPLY_OF_SEALED_PLAN" | "CLOUDFORMATION_EXECUTE_OF_SEALED_CHANGE_SET";
    agentInitiated: false;
  };
  /** Present when the engine left errored.tfstate or crash.log: kept encrypted in the vault, referenced here by count and hash only. */
  recovery?: { files: number; sha256: string };
};

export type ApplyResult =
  | { ok: true; evidence: ApplyEvidence }
  | { ok: false; code: ApplyRefusalCode; message: string; outcome?: ApplyOutcome };
