import type { Provider } from "../discovery/types.js";
import type { IaCEngine } from "../build/types.js";

/**
 * Traceable teardown (docs/teardown-traceability.md).
 *
 * A deletion unit is the one engine-native state container a build creates
 * into. Undoing a build means destroying exactly that unit with the engine's
 * own command — never sweeping an account. Everything here is a record or a
 * read-only evaluation: nothing in src/teardown executes, deletes or grants
 * delete authority, and ACT stays DISABLED.
 */

/** Where the engine keeps the state that knows what this build created. */
export type DeletionUnitStateRef =
  | {
    engine: "TERRAFORM" | "OPENTOFU";
    backend: "s3" | "azurerm" | "gcs" | "remote" | "http" | "consul" | "pg" | "local";
    /** Backend-specific location, e.g. "s3://bucket/path/terraform.tfstate". */
    location: string;
    workspace: string;
  }
  | { engine: "PULUMI"; backendUrl: string; stack: string }
  | { engine: "CLOUDFORMATION" | "AWS_CDK"; region: string; stackName: string }
  /** Azure Deployment Stack: the stack itself tracks every resource it manages. */
  | { engine: "BICEP"; scope: string; deploymentStackName: string }
  | { engine: "CROSSPLANE"; apiVersion: string; kind: string; name: string; namespace?: string };

export type ProvenanceTags = {
  "alz-managed-by": "alz";
  "alz-unit": string;
  "alz-build": string;
  /** Optional expiry (YYYY-MM-DD) for short-lived builds; reported, never enforced. */
  "alz-expires"?: string;
};

export type DeletionUnit = {
  schemaVersion: 1;
  unitId: string;
  buildId: string;
  provider: Provider;
  engine: Exclude<IaCEngine, "ANSIBLE">;
  stateRef: DeletionUnitStateRef;
  designHash: string;
  /** Hash of the normalized create ChangeSet the unit was recorded from. */
  createChangeSetHash: string;
  /** Sorted, unique engine addresses the build planned to CREATE. */
  plannedCreates: string[];
  tags: ProvenanceTags;
  recordedAt: string;
  unitHash: string;
};

/** Tags as an engine plan reports them for one planned resource. */
export type PlannedTags =
  | { kind: "TAGGED"; tags: Record<string, string> }
  /** The resource type has no tags; it is traceable through state only. */
  | { kind: "UNTAGGABLE" }
  /** Tags are computed at apply time, so the plan cannot prove them. */
  | { kind: "UNKNOWN_AT_PLAN" };

export type CreateTraceabilityReport = {
  verdict: "TRACEABLE" | "BLOCKED";
  unitId: string;
  /** VERIFIED when the plan exposes tags; UNVERIFIED for engines without a tag reader. */
  tagCoverage: "VERIFIED" | "UNVERIFIED";
  tagged: string[];
  stateOnly: string[];
  reasons: string[];
};

export type DestroyPreview = {
  verdict: "READY_FOR_AUTHORIZATION" | "NOTHING_TO_DESTROY" | "BLOCKED";
  unitId: string;
  unitHash: string;
  destroyChangeSetHash: string;
  deletes: string[];
  /** Recorded creates the destroy plan does not include (already gone, or never created). */
  alreadyAbsent: string[];
  reasons: string[];
  executionMode: "PREVIEW_ONLY";
  infrastructureAct: "DISABLED";
};

export type OrphanFinding = {
  resourceId: string;
  status: "TRACKED" | "ORPHAN_UNATTRIBUTED" | "ORPHAN_UNKNOWN_UNIT" | "TAG_CONFLICT";
  unitId?: string;
  expired: boolean;
  detail: string;
};

export type OrphanReport = {
  action: "REPORT_ONLY";
  findings: OrphanFinding[];
  orphans: number;
  expired: number;
};
