import type { ResolvedTarget } from "../teardown/driver/types.js";
import type { ExecutionIdentity } from "../tools/identity.js";
import type { AwsTarget } from "./providers/aws.js";
import type { AzureTarget } from "./providers/azure.js";
import type { GcpTarget } from "./providers/gcp.js";

/**
 * The pilot apply contract (docs/act-pilot-plan.md).
 *
 * The operator authorizes, the driver enforces, and agents never initiate an
 * apply. Everything here is human-invoked: nothing under src/apply is reachable
 * from src/tools or any agent path, and from the console side only the wizard's
 * adapter (src/cli/ui-channel.ts, a person with the session token) reaches it;
 * the console's job table never runs an apply. ACT stays DISABLED unless a valid
 * pilot contract enables it.
 */
/**
 * The one channel a pilot workflow runs through, chosen when it is started and never mixed (docs/act-pilot-walkthrough.md):
 * `CLI` is a person at the terminal, `UI` is a person in the console wizard. The CALLER sets it (a deps seam, never a flag or a
 * file), it is sealed into the plan and so into the artifact hash every approver signs, and `approve` and `apply` refuse
 * (`CHANNEL_MISMATCH`) when they are invoked through the other one. It widens who may invoke the pilot, not what any gate checks.
 */
export type PilotChannel = "CLI" | "UI";
export const PILOT_CHANNELS: readonly PilotChannel[] = ["CLI", "UI"];

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
export type EngineId = "TERRAFORM" | "CDK" | "BICEP" | "GCP_API";

/** The providers the pilot has a spec for (src/apply/provider.ts). The contract's `provider` selects one; anything else is not a contract. */
export type ProviderId = "AZURE" | "AWS" | "GCP";

/**
 * The canary allowlist (owner decision E1, docs/act-pilot-apply.md, "Canary allowlist"): the exact resource types an APPLY in this
 * environment may create, each with its exact count, in the engine's own type names (Terraform `aws_cloudwatch_log_group`,
 * CloudFormation `AWS::Logs::LogGroup`). Part of the target, so it is in the target hash every seal, approval and evidence record binds.
 */
export type PilotCanary = { resources: { type: string; count: number; retain?: true }[] };

/** One environment's exact target, in the shape the contract's provider defines, with its optional canary allowlist. Real values come from the owner; tests use explicit fixtures. */
export type PilotTarget = (AzureTarget | AwsTarget | GcpTarget) & { canary?: PilotCanary };

/** What ACT can be authorized for: an apply, a cleanup of what a run created, or a removal of what the product generated. */
export type ActOperation = "APPLY" | "CLEANUP" | "REMOVE";
export const ACT_OPERATIONS: readonly ActOperation[] = ["APPLY", "CLEANUP", "REMOVE"];

export type PilotContract = {
  schemaVersion: 1;
  /** ACT is off unless this is exactly true. A missing or malformed contract is off. */
  enabled: boolean;
  provider: ProviderId;
  engine: EngineId;
  /** Unconfigured environments have no target. DEV is always required. */
  targets: Partial<Record<ApplyEnvironment, PilotTarget>> & { DEV: PilotTarget };
  /** Optional narrow pilot scope; absent preserves the original DEV/QA/PROD contract. */
  enabledEnvironments?: ApplyEnvironment[];
  /**
   * The default-deny ACT authorization (owner direction, #39): per environment, the operations ACT may run under this
   * contract, for its provider, engine and that environment's account. The owner's reviewed commit of the contract is the
   * authorization. Absent or empty means ACT is disabled; an environment or operation not listed is refused.
   */
  authorize?: Partial<Record<ApplyEnvironment, ActOperation[]>>;
  /** Distinct verified approvals required per environment. DEV and QA at least 1, PROD at least 2. */
  requiredApprovals: Partial<Record<ApplyEnvironment, number>> & { DEV: number };
  maxApprovalAgeMinutes: number;
  /** The approver allowlist lives in the reviewed contract, never in an operator-supplied file. Ids and public keys are unique. */
  approvers: ApproverEntry[];
  /** Existence of this file stops an apply before it starts and between steps. */
  killSwitchPath: string;
  /**
   * The policy version the owner has reviewed for this pilot. `./alz apply prepare` copies it into the request and
   * manifest, so operators never type it. Optional: absent keeps an existing contract byte-for-byte as it was, and
   * prepare then stops with an owner prerequisite instead of guessing.
   */
  policyVersion?: string;
  /**
   * Required true for the Terraform engine (owner decision 6486426552: a Terraform contract without it fails to load), and refused for an
   * engine with no state backend. The seal-time `init` embeds STATE_WRITE's non-secret backend settings, so the plan names the state
   * writer (docs/act-pilot-apply.md, "Binding STATE_WRITE in the plan"). It is part of the reviewed contract, so the sealed plan binds it
   * through `contractSha256`.
   */
  embedStateWrite?: boolean;
};

/** The allowlist of people who may approve. A typed name is never proof; a verified signature is. */
export type ApproverEntry = { id: string; publicKeyPem: string; environments: ApplyEnvironment[] };

/** The kinds of action an approval can authorize: an apply of a sealed plan, or a cleanup of an approved proposal. Signatures are domain-separated by kind (src/apply/approval.ts). */
/**
 * What a signature is for: an apply approval, a cleanup approval, the requester's signature on a sealed request, or the
 * requester's signature on a cleanup proposal. Each has its own domain and none verifies as another.
 */
export type ApprovalSubject = "APPLY" | "CLEANUP" | "REQUEST" | "CLEANUP_REQUEST";
export const APPROVAL_SUBJECTS: readonly ApprovalSubject[] = ["APPLY", "CLEANUP", "REQUEST", "CLEANUP_REQUEST"];

/**
 * What the requester signs at seal (docs/act-pilot-plan.md, authority item 3; owner decisions on issue #39, 2026-10-27):
 * the artifact hash, the environment and a one-time nonce, under the REQUEST domain, with an allowlisted key. The
 * artifact hash binds the requester id, so every approver signs who requested, and in PROD no approval may come from
 * the requester's key or id. A cleanup proposal carries the same statement over the proposal's own hash, under the
 * CLEANUP_REQUEST domain (owner decision 6440801434, item 1).
 */
export type RequestStatement = {
  schemaVersion: 1;
  requesterId: string;
  artifactSha256: string;
  environment: ApplyEnvironment;
  /**
   * 128-bit random value, recorded (not consumed) when the plan is applied. Replay is prevented by the artifact ledger: an
   * artifact applies once, and a second apply of it is refused as ARTIFACT_ALREADY_APPLIED.
   */
  nonce: string;
};
export type SealedRequest = { statement: RequestStatement; signatureBase64: string };

/** What an approver signs. It binds one approval to one artifact (a sealed plan, or a cleanup proposal by its hash), one target and one moment. */
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
  /** 2 since the requester signs the sealed request; a schema 1 record (no requester) is refused everywhere. */
  schemaVersion: 2;
  artifactSha256: string;
  planSha256: string;
  manifestHash: string;
  /** Target-independent identity of the qualified release: project files, lock file, engine and provider versions, shared inputs. Production promotes this, never a dev plan or dev manifest hash. */
  releaseIdentity: string;
  environment: ApplyEnvironment;
  target: ResolvedTarget;
  /** The channel this workflow was started in (`CLI` or `UI`). Bound by the artifact hash: the other channel cannot approve or apply it. */
  channel: PilotChannel;
  engineVersion: string;
  policyVersion: string;
  /**
   * AUTHORIZED, as sealed: the canonical hash of the contract's authorizing entry for this APPLY (`authorizationEntryOf`). Bound
   * by the artifact hash with `contractSha256`, so every approval covers the exact authorization; the apply derives it again
   * from the contract it loads and refuses, with nothing consumed, if it changed.
   */
  authorizationSha256: string;
  /** The run's full target (`pilotTargetSha256`: provider, account fields incl. tenant and region, backend, workspace), bound by the artifact hash. */
  targetSha256: string;
  /** The pilot contract (its canonical sha256) the plan was sealed under: it fixes the provider and every account field, region and tenant included, and the approver allowlist. An apply under another contract is refused. */
  contractSha256: string;
  /** The product source commit that made this plan, bound by the artifact hash: approvers sign it, and only the same commit can apply it. */
  sourceCommit: string;
  createdAt: string;
  /** Normalized, redacted change summary: address, type, action, and what else an approver must see (an import, a move, a forget, an output change). Never plan values. */
  changes: PlanChange[];
  /** Which engine made the preview, as observed when it was sealed. Bound by the artifact hash: approvers sign it. */
  provenance: PreviewProvenance;
  /** The deletion unit the plan stamps on what it creates, verified in the plan at sealing. Bound by the artifact hash. */
  unit: SealedUnit | null;
  /** Who requested this change, by allowlist id. Bound by the artifact hash, so every approver signs it; in PROD no approval may come from this id or its key. */
  requesterId: string;
  /** The requester's signature over the artifact hash, environment and a nonce (REQUEST domain). Beside the hashed fields, since it signs the hash. Null only for a throwaway plan, which is never stored. */
  request: SealedRequest | null;
};

/**
 * Where a preview came from (docs/act-pilot-apply.md, "Preview provenance"). The tool pins hash the downloaded archive,
 * not the program, so the observable check is the qualification evidence: it records the hash of the program it ran.
 */
export type PreviewProvenance = {
  /**
   * SHA-256 of the engine program the preview ran: the terraform binary, the aws CLI for CDK, or for GCP_API (no external program) the
   * hash of the engine's own module closure (D1). An apply with another program or module is refused.
   */
  engineBinarySha256: string;
  /** Whether real-engine qualification evidence covers this program, engine version and preview adapter for this target, or why not. */
  qualification: { state: "QUALIFIED"; evidenceHash: string; qualifiedAt: string } | { state: "UNQUALIFIED"; reason: string };
};

/**
 * One line of the change list. `FORGET` removes a resource from state and leaves the real one; an output change is a
 * line with address `output.<name>` and type `output`; `importing` and `previousAddress` (a move) are set only when the
 * plan says so. Addresses never carry bidi or zero-width control characters (see `stripInvisible`).
 */
export type PlanChange = { address: string; type: string; action: string; importing?: true; previousAddress?: string };

/**
 * The deletion unit the sealed plan stamps on what it creates (src/apply/unit.ts): the unit id, the tags every created,
 * taggable resource was verified to carry in the plan, and the created resources whose type carries no tags (traceable
 * through the state only). Bound by the artifact hash, so approvers sign it. Null for an engine without a tag reader.
 */
export type SealedUnit = { unitId: string; tags: Record<string, string>; untagged: string[] };

export type ApplyRefusalCode =
  | "ACT_DISABLED"
  /** The reviewed contract's `authorize` does not list this operation for this environment. Nothing ran. */
  | "ACT_NOT_AUTHORIZED"
  /** The contract authorizes APPLY for an environment whose target names no canary allowlist (`PilotCanary`). Nothing ran. */
  | "CANARY_ALLOWLIST_MISSING"
  /** The plan or change set does anything but create exactly the canary allowlist's types and counts. Nothing was sealed or applied. */
  | "RESOURCE_NOT_IN_CANARY"
  /** The contract or its authorizing entry changed since the plan was sealed or the cleanup proposed. Nothing was consumed. */
  | "ACT_AUTHORIZATION_CHANGED"
  | "CONTRACT_INVALID"
  /** The contract names a planned provider and engine (GCP Terraform, GCP API-native) whose lane has not landed. ACT stays disabled. */
  | "NOT_IMPLEMENTED"
  | "IDENTITY_TARGET_MISMATCH"
  | "KILL_SWITCH_ACTIVE"
  /** The kill switch appeared after the approvals were consumed and before the engine started: nothing applied, the approvals are spent. */
  | "KILL_SWITCH_AFTER_APPROVALS"
  | "HUMAN_INVOCATION_REQUIRED"
  /** The workflow was started in the other channel (terminal or console). Nothing was consumed. */
  | "CHANNEL_MISMATCH"
  /** The product source commit could not be established, or the checkout has uncommitted changes. Nothing was consumed. */
  | "SOURCE_UNVERIFIED"
  /** The running product is not the commit the plan was sealed from. Nothing was consumed. */
  | "SOURCE_CHANGED"
  /** The engine program on this machine is not the one that made the sealed preview. Nothing was consumed. */
  | "ENGINE_BINARY_CHANGED"
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
  /** PROD (an apply or a cleanup): an approval comes from the requester's id or key. The requester and the approvers must be three distinct people. Nothing was consumed. */
  | "APPROVER_IS_REQUESTER"
  /** The requester named at seal is not on the contract's allowlist. Nothing ran. */
  | "REQUESTER_NOT_ALLOWED"
  /** The key handed to seal is not the allowlisted key of the requester named. Nothing ran. */
  | "REQUESTER_KEY_MISMATCH"
  /** The sealed plan or the cleanup proposal carries no requester signature. Nothing was consumed. */
  | "REQUESTER_SIGNATURE_MISSING"
  /** The requester signature does not verify against the allowlisted key, or was made for another kind of action. Nothing was consumed. */
  | "REQUESTER_SIGNATURE_UNVERIFIED"
  /** The requester signature names another artifact, environment or requester than the sealed plan. Nothing was consumed. */
  | "REQUESTER_MISBOUND"
  | "ARTIFACT_ALREADY_APPLIED"
  | "ENGINE_NOT_QUALIFIED"
  | "PROMOTION_EVIDENCE_MISSING"
  | "IDENTITY_NOT_CONFIGURED"
  | "IDENTITY_COLLAPSED"
  | "PLAN_STALE"
  | "APPLY_FAILED"
  /** The approvals were consumed and the engine did not start (a plan write, spawn or preparation failure): nothing ran, the approvals are spent. */
  | "APPROVALS_SPENT"
  | "EVIDENCE_REJECTED"
  /** The record a cleanup needs (the apply's evidence, its blueprint, a fresh observation) is missing, unreadable or does not belong to this run. Nothing was consumed. */
  | "RUN_RECORD_MISSING"
  /** A cleanup proposal cannot be made: the apply did not succeed, a planned resource never reached the state, or a resource's origin cannot be told. A person reviews. */
  | "OWNERSHIP_AMBIGUOUS"
  /** The observation a proposal rests on could not decide for a resource this run created, or found something unexpected. Observe again. */
  | "OBSERVATION_INCONCLUSIVE"
  /** The observation found a resource this run created outside the contract's location: FAILED, and no ordinary cleanup is proposed. A governed location remediation may be. */
  | "LOCATION_MISMATCH"
  /** A location remediation cannot be proposed for this run (another path, more than one resource, not created by the run, ambiguous or unobserved). Nothing was written. */
  | "REMEDIATION_NOT_ELIGIBLE"
  /** A location remediation's recheck, immediately before the approvals are consumed, did not find the network exactly as proposed. Nothing was deleted and no approval was consumed. */
  | "REMEDIATION_RECHECK_FAILED"
  /** The cleanup proposal is malformed, or does not hash to its own identity. Nothing was consumed. */
  | "PROPOSAL_INVALID"
  /** The engine's destroy plan is not exactly the approved proposal's resource list (state or dependencies changed). Nothing was applied and no approval was consumed. */
  | "PROPOSAL_SCOPE_MISMATCH"
  /** The proposal was already executed, or another run holds it. */
  | "PROPOSAL_ALREADY_EXECUTED"
  /** The contract's engine has no cleanup adapter (CDK stack deletion needs its own decision). */
  | "CLEANUP_NOT_SUPPORTED"
  /** A CDK removal would leave the stack with no resource. The stack is never deleted by a cleanup; retiring it with its last resources is the owner's separate decision. Nothing was consumed. */
  | "CLEANUP_WOULD_EMPTY_STACK"
  /** An approved resource's deletion policy keeps it when it is removed from the template, so the removal would not delete it. Nothing was consumed. */
  | "CLEANUP_RETAIN_POLICY"
  /** A resource or output that stays still refers to an approved one, so the removal would break or take along something not on the list. Nothing was consumed. */
  | "CLEANUP_DEPENDENT_REFERENCED";

export type ApplyOutcome = "SUCCEEDED" | "FAILED_NO_CHANGE" | "PARTIAL_REQUIRES_REVIEW" | "KILLED";

/**
 * The three decisions a run rests on, recorded in its evidence (owner decisions, #39): AUTHORIZED (the reviewed contract's
 * hash and its authorizing entry's hash), READY (the engine program and the qualification evidence the run was admitted with; null where the
 * operation has no qualification gate) and EXECUTE (the requester and the approvers, also in `requester` and `approvals`).
 */
export type RunDecisions = {
  authorized: { operation: "APPLY" | "CLEANUP"; contractSha256: string; authorizationSha256: string };
  ready: { engineBinarySha256: string | null; qualificationEvidenceHash: string | null };
  execute: { requesterId: string; approverIds: string[] };
};

/** Encrypted at rest. Never carries plan values, state, or raw engine output. */
export type ApplyEvidence = {
  schemaVersion: 1;
  environment: ApplyEnvironment;
  target: ResolvedTarget;
  artifactSha256: string;
  manifestHash: string;
  releaseIdentity: string;
  /** The contract the apply ran under, and so the provider, account, region or tenant it ran against. */
  contractSha256: string;
  /** The run's full target (`pilotTargetSha256`), from the sealed plan: what its cleanup and removal must find unchanged. */
  targetSha256: string;
  decisions: RunDecisions;
  /** The product source commit that sealed the plan and ran the apply (they must be the same). */
  sourceCommit: string;
  approvals: { approverId: string; issuedAt: string }[];
  /**
   * Who requested the change (the verified requester signature's id) and the nonce that signature carried. The nonce is
   * recorded, not consumed; the artifact ledger prevents replay (ARTIFACT_ALREADY_APPLIED).
   */
  requester: { requesterId: string; nonce: string };
  adapter: { adapterVersion: string; argvDigest: string };
  toolVersions: { engine: string };
  outcome: ApplyOutcome;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string;
  authority: {
    infrastructureAct: "PILOT_ENABLED";
    /**
     * What the engine did: Terraform applied the sealed plan, CloudFormation executed the sealed change set, an Azure deployment
     * stack was created from the sealed template, or (GCP API-native, D16) the one sealed Pub/Sub topic create was sent.
     */
    mutation: "TERRAFORM_APPLY_OF_SEALED_PLAN" | "CLOUDFORMATION_EXECUTE_OF_SEALED_CHANGE_SET" | "AZURE_DEPLOYMENT_STACK_CREATE_OF_SEALED_TEMPLATE" | "GCP_PUBSUB_TOPIC_CREATE_OF_SEALED_REQUEST";
    agentInitiated: false;
  };
  /** Present when the engine left errored.tfstate or crash.log: kept encrypted in the vault, referenced here by count and hash only. */
  recovery?: { files: number; sha256: string };
  /**
   * GCP API-native (D11), SUCCEEDED runs only: the one property the engine set and read back as sealed, by name, with its sealed value
   * (`messageStoragePolicy.allowedPersistenceRegions`, `[region]`). It names one Pub/Sub property; it is not a data-residency claim.
   */
  verifiedProperty?: { name: string; value: string[] };
};

export type ApplyResult =
  | { ok: true; evidence: ApplyEvidence }
  | { ok: false; code: ApplyRefusalCode; message: string; outcome?: ApplyOutcome };

/**
 * What a cleanup leaves in the ledger, under the proposal's hash (docs/act-pilot-plan.md, "Cleanup of pilot-created
 * resources"). Same closed shape discipline as `ApplyEvidence`: identifiers and hashes, never a state value or engine output.
 */
export type CleanupEvidence = {
  schemaVersion: 1;
  kind: "CLEANUP";
  environment: ApplyEnvironment;
  target: ResolvedTarget;
  /** The approved proposal this cleanup executed, and the run it cleaned up. */
  proposalSha256: string;
  artifactSha256: string;
  applyEvidenceSha256: string;
  contractSha256: string;
  decisions: RunDecisions;
  sourceCommit: string;
  approvals: { approverId: string; issuedAt: string }[];
  /**
   * Who requested the cleanup (the verified cleanup request signature's id) and the nonce that signature carried. The nonce
   * is recorded, not consumed; the cleanup ledger executes a proposal once (PROPOSAL_ALREADY_EXECUTED).
   */
  requester: { requesterId: string; nonce: string };
  adapter: { adapterVersion: string; argvDigest: string };
  toolVersions: { engine: string };
  /** The addresses the engine was told to destroy: the proposal's list, exactly. */
  deletes: string[];
  outcome: ApplyOutcome;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string;
  authority: {
    infrastructureAct: "PILOT_ENABLED";
    mutation: "TERRAFORM_DESTROY_OF_APPROVED_PROPOSAL" | "CLOUDFORMATION_EXECUTE_OF_REMOVAL_CHANGE_SET" | "AZURE_DEPLOYMENT_STACK_DELETE_OF_RUN_STACK" | "GCP_PUBSUB_TOPIC_DELETE_OF_RUN_TOPIC";
    /** The identity that executed: the pilot's APPLY identity (owner decision, 2026-10-25), bound to `deletes`. */
    executedAs: "APPLY";
    agentInitiated: false;
  };
  recovery?: { files: number; sha256: string };
  /**
   * GCP API-native (D16): whether this run's own DELETE removed the topic. False means it was already absent (a 404 and an absent
   * read-back): the cleanup SUCCEEDED, but this run did not delete it. Absent for the other engines.
   */
  deletedByRun?: boolean;
};

export type CleanupResult =
  | { ok: true; evidence: CleanupEvidence }
  | { ok: false; code: ApplyRefusalCode; message: string; outcome?: ApplyOutcome };
