import type { ChangeSet, ResourceChange } from "../../iac/changeset.js";
import type {
  ArtifactManifest,
  InputMode,
  ManifestDependency,
  ManifestEngine,
  ManifestInput,
  ManifestProvider,
  StateVersionRecord,
} from "../manifest.js";
import type { DeletionUnit, DestroyPreview } from "../types.js";

/**
 * The destroy-preview driver contract (docs/destroy-preview-driver.md).
 *
 * The operator authorizes the preview, the driver enforces the contract, and
 * no preview capability grants authority to change infrastructure. The driver
 * is human-invoked only. It is not a broker tool, and nothing in this
 * directory is reachable from src/tools.
 */
export type DriverEngine = ManifestEngine;
export const DRIVER_ENGINES: readonly DriverEngine[] = ["TERRAFORM", "OPENTOFU", "PULUMI"];

/** Ordinary preview and destroy preview are separate operations. */
export type PreviewOperation = "PREVIEW" | "DESTROY_PREVIEW";

/** The exact target a person names: account or subscription, backend, workspace or stack. */
export type ResolvedTarget = { account: string; backend: string; workspace: string };

/**
 * Proof that a person at an interactive session asked for this preview and
 * typed the exact target. Without it nothing runs. An agent cannot produce
 * one: the CLI lane builds it from a real terminal prompt.
 */
export type HumanInvocation = {
  operatorId: string;
  interactiveSession: true;
  confirmedTarget: ResolvedTarget;
  confirmedAt: string;
};

export type GrantedCapabilities = {
  cloudRead: boolean;
  /** Needed for PROJECT mode. Approving it never grants mutation. */
  projectCodeExecution: boolean;
};

/** What the caller resolved about the inputs, to be compared with the sealed manifest. */
export type ResolvedInputs = {
  engineVersion: string;
  providers: ManifestProvider[];
  /** Terraform and OpenTofu, PROJECT mode. */
  lockFileSha256?: string;
  dependencies: ManifestDependency[];
  inputs: ManifestInput[];
  /** STATE_DERIVED mode. */
  executionManifestSha256?: string;
};

/**
 * Every field a request may carry. A request with any other field is refused,
 * whatever it is called: there is nothing to turn a check off.
 */
export type PreviewRequest = {
  engine: DriverEngine;
  mode: InputMode;
  invocation: HumanInvocation;
  target: ResolvedTarget;
  manifest: ArtifactManifest;
  unit: DeletionUnit;
  /** The working project. Never run from directly: the driver runs a snapshot of it. */
  projectRoot: string;
  capabilities: GrantedCapabilities;
  policyVersion: string;
  resolved: ResolvedInputs;
};

export const REQUEST_KEYS: readonly string[] = [
  "engine", "mode", "invocation", "target", "manifest", "unit", "projectRoot", "capabilities",
  "policyVersion", "resolved",
];
export const NESTED_REQUEST_KEYS: Readonly<Record<string, readonly string[]>> = {
  invocation: ["operatorId", "interactiveSession", "confirmedTarget", "confirmedAt"],
  confirmedTarget: ["account", "backend", "workspace"],
  target: ["account", "backend", "workspace"],
  capabilities: ["cloudRead", "projectCodeExecution"],
  resolved: ["engineVersion", "providers", "lockFileSha256", "dependencies", "inputs", "executionManifestSha256"],
};

export type PreviewAuthority = {
  infrastructureAct: "DISABLED";
  mutation: "NONE";
  executionMode: "PREVIEW_ONLY";
  agentInitiated: false;
};

export type AdapterDescriptor = { engine: DriverEngine; adapterVersion: string; argvDigest: string };

/**
 * What a preview leaves behind. It carries the normalized, redacted change
 * set (address, type and operation only), hashes and versions. Never a plan,
 * a state document or raw `show -json` output.
 */
export type PreviewEvidence = {
  schemaVersion: 1;
  operation: PreviewOperation;
  engine: DriverEngine;
  mode: InputMode;
  adapter: AdapterDescriptor;
  toolVersions: { engine: string; adapter: string };
  changes: ChangeSet;
  hashes: { manifestHash: string; unitHash: string; changeSetHash: string };
  /** Recorded beside the manifest hash, never inside it. */
  stateVersion: StateVersionRecord;
  label: "ARTIFACT_VALIDATED_DESTROY_PREVIEW" | "INVENTORY_ONLY_NOT_ARTIFACT_VALIDATED";
  /** evaluateDestroyPreview's verdict for a destroy preview; null for an ordinary preview. */
  verdict: DestroyPreview["verdict"] | null;
  target: ResolvedTarget;
  policyVersion: string;
  invokedBy: { operatorId: string; confirmedAt: string };
  startedAt: string;
  finishedAt: string;
  authority: PreviewAuthority;
};

/** Handed to an adapter. The request has already been validated and snapshotted. */
export type AdapterContext = {
  /** Read-only snapshot of the manifest's files. Null in STATE_DERIVED mode, which runs no project. */
  snapshotPath: string | null;
  /** A fresh 0700 directory. Plan files go here only; the driver deletes it afterwards. */
  scratchDir: string;
  /** The identity names to pass as the process runner's `identity` option. An adapter chooses nothing else. */
  identities: { providerReads: "DISCOVERY"; stateReads: "STATE" };
  /** The environment the runner reads identity variables from. */
  env: NodeJS.ProcessEnv;
};

export const ADAPTER_IDENTITIES: AdapterContext["identities"] = {
  providerReads: "DISCOVERY",
  stateReads: "STATE",
};

/**
 * One engine's execution behind the common contract. An adapter never
 * validates a manifest, chooses an identity or decides a verdict, and it never
 * runs apply, destroy or a shell. It runs its pinned argv and reports.
 */
export interface EngineAdapter {
  readonly engine: DriverEngine;
  readonly adapterVersion: string;
  /** Digest of the exact argument lists this adapter runs; see argvDigest(). */
  readonly argvDigest: string;
  preview(request: PreviewRequest, context: AdapterContext): PreviewEvidence;
  destroyPreview(request: PreviewRequest, context: AdapterContext): PreviewEvidence;
}

export type DriverRefusalCode =
  | "HUMAN_INVOCATION_REQUIRED"
  | "HUMAN_CONFIRMATION_MISMATCH"
  | "UNKNOWN_REQUEST_FIELD"
  | "ENGINE_NOT_QUALIFIED"
  | "CLOUD_READ_REQUIRED"
  | "PROJECT_CODE_EXECUTION_REQUIRED"
  | "IDENTITY_NOT_CONFIGURED"
  | "IDENTITY_COLLAPSED"
  | "IDENTITY_FORBIDDEN"
  | "MODE_NOT_SUPPORTED"
  | "UNIT_INVALID"
  | "UNIT_TARGET_MISMATCH"
  | "MANIFEST_INVALID"
  | "REVIEW_REQUIRED"
  | "SNAPSHOT_REFUSED"
  | "SNAPSHOT_CHANGED"
  | "ADAPTER_FAILED"
  | "EVIDENCE_REJECTED";

export type DriverResult =
  | { ok: true; evidence: PreviewEvidence; preview?: DestroyPreview }
  | {
    ok: false;
    code: DriverRefusalCode;
    message: string;
    /** REVIEW_REQUIRED only: the manifest fields that differ. Hashes and versions, never values. */
    fields?: string[];
  };

export type { ChangeSet, ResourceChange };
