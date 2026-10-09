import { sha256 } from "../build/provenance.js";
import type { IaCEngine } from "../build/types.js";
import type { Provider, EnvironmentState } from "../discovery/types.js";
import { PLUGIN_CATALOG } from "../plugins/catalog.js";
import type { DesignSpec } from "./types.js";

export type DesignBuildHandoffStatus = "READY_FOR_PREVIEW" |
  "REVIEW_REQUIRED" | "BLOCKED";

export type DesignBuildHandoff = {
  schemaVersion: 1;
  status: DesignBuildHandoffStatus;
  provider: Provider;
  engine: IaCEngine;
  designId: string;
  designHash: string;
  policyHash: string;
  environmentHash: string;
  handoffHash: string;
  discoveryMode: "SYNTHETIC" | "REAL_DISCOVERY" | "UNKNOWN";
  evidencePath: DesignSpec["plugin"]["evidencePath"];
  resourceActions: Array<{
    resourceId: string;
    action: DesignSpec["entries"][number]["action"];
    requiresExplicitAuthorization: boolean;
  }>;
  blockers: string[];
  reviewRequired: string[];
  infrastructureAct: "DISABLED";
};

/** Rebuild the hash from DesignSpec content, ignoring identity/timestamp fields
 * exactly as the existing createDesignSpec() algorithm does.
 * This also rejects in-place mutation of policy, ownership and resource intent.
 */
export function calculateDesignContentHash(design: DesignSpec): string {
  return sha256(JSON.stringify({
    provider: design.provider,
    environment: design.environment,
    objective: design.objective,
    status: design.status,
    plugin: design.plugin,
    entries: design.entries,
    constraints: design.constraints,
    reuse: design.reuse,
    additions: design.additions,
    forbiddenChanges: [...design.forbiddenChanges].sort(),
    policies: design.policies,
    securityControls: design.securityControls,
    resiliencyControls: design.resiliencyControls,
    assumptions: design.assumptions,
    evidenceRefs: [...new Set(design.evidenceRefs)].sort(),
  }));
}

/** Immutable review packet consumed by every provider-specific BUILD adapter.
 * A READY_FOR_PREVIEW result never supplies deployment/mutation authority.
 */
export function evaluateDesignBuildHandoff(input: {
  environment: EnvironmentState;
  design: DesignSpec;
  provider: Provider;
  engine: IaCEngine;
}): DesignBuildHandoff {
  const { environment, design, provider, engine } = input;
  const blocked = new Set<string>();
  const review = new Set<string>();
  const hash = /^[a-f0-9]{64}$/;
  const plugin = PLUGIN_CATALOG.find((item) => item.id === engine);

  if (!hash.test(design.designHash) ||
      calculateDesignContentHash(design) !== design.designHash) {
    blocked.add("DESIGN_CONTENT_HASH_MISMATCH");
  }
  if (!hash.test(design.policies.bundleHash) ||
      !design.evidenceRefs.includes("policy:" + design.policies.bundleHash)) {
    blocked.add("POLICY_EVIDENCE_NOT_BOUND");
  }
  if (design.provider !== provider ||
      design.provider !== environment.provider ||
      design.environment !== environment.classification) {
    blocked.add("PROVIDER_OR_ESTATE_MISMATCH");
  }
  if (design.plugin.plugin !== engine || !plugin ||
      !plugin.providers.includes(provider) ||
      plugin.status !== "IMPLEMENTED" ||
      !plugin.stage.includes("BUILD") ||
      design.plugin.status !== "READY" || !design.plugin.buildEligible) {
    blocked.add("UNSUPPORTED_OR_UNAVAILABLE_BUILD_ADAPTER");
  }
  if (plugin && design.plugin.evidencePath === undefined) {
    blocked.add("PREVIEW_EVIDENCE_PATH_REQUIRED");
  }
  if (environment.classification === "UNKNOWN" ||
      environment.safeBuildMode === "BLOCKED" ||
      environment.safeBuildMode === "READ_ONLY" ||
      environment.resources.some((resource) =>
        resource.ownership === "UNKNOWN" ||
        resource.mutationPolicy === "DELETE_ALLOWED") ||
      environment.conflicts.length > 0 ||
      environment.warnings.some((warning) =>
        warning.startsWith("DISCOVERY_PARTIAL"))) {
    blocked.add("UNKNOWN_OWNERSHIP_OR_UNSAFE_DISCOVERY");
  }
  if (provider === "AWS" && environment.classification === "GREENFIELD" &&
      (engine === "CLOUDFORMATION" || engine === "AWS_CDK")) {
    blocked.add("EXISTING_STACK_REQUIRED");
  }
  if (design.status === "BLOCKED") blocked.add("DESIGN_BLOCKED");

  const entries = design.entries;
  const actions = new Set(entries.map((entry) => entry.resourceId));
  if (actions.size !== entries.length ||
      entries.some((entry) => !entry.resourceId || !entry.resourceType)) {
    blocked.add("DUPLICATE_OR_EMPTY_RESOURCE_DECISION");
  }
  const eq = (actual: string[], expected: string[]) =>
    actual.length === expected.length &&
    [...actual].sort().every((item, i) => item === [...expected].sort()[i]);
  if (!eq(design.reuse, entries.filter((entry) =>
      entry.action === "REUSE" || entry.action === "INTEGRATE")
      .map((entry) => entry.resourceId)) ||
      !eq(design.additions, entries.filter((entry) =>
        entry.action === "ADD").map((entry) => entry.resourceId))) {
    blocked.add("DESIGN_RESOURCE_ACTION_LIST_MISMATCH");
  }
  if (design.forbiddenChanges.some((id) => design.additions.includes(id)) ||
      entries.some((entry) => (
        (entry.action === "NO_TOUCH" || entry.action === "BLOCKED") &&
        !design.forbiddenChanges.includes(entry.resourceId)
      )) ||
      environment.resources.some((resource) =>
        resource.mutationPolicy === "READ_ONLY" &&
        !design.forbiddenChanges.includes(resource.resourceId))) {
    blocked.add("FORBIDDEN_RESOURCE_INTENT");
  }
  // Preview cannot implicitly adopt or reconfigure existing assets.
  if (entries.some((entry) =>
      entry.action === "ADOPT" || entry.action === "CONFIGURE")) {
    review.add("EXPLICIT_EXISTING_RESOURCE_AUTHORIZATION_REQUIRED");
  }
  if (design.additions.length === 0) {
    review.add("EXPLICIT_ADD_RESOURCE_DESIGN_REQUIRED");
  }
  if (design.status === "REVIEW_REQUIRED") {
    review.add("DESIGN_OWNER_REVIEW_REQUIRED");
  }
  if (environment.warnings.length > 0) {
    review.add("ENVIRONMENT_WARNINGS_REQUIRE_REVIEW");
  }
  const discoveryMode: DesignBuildHandoff["discoveryMode"] =
    environment.evidence.length === 0 ? "UNKNOWN" :
    environment.evidence.some((item) => item.source === "mock" ||
      item.source === "fixture") ? "SYNTHETIC" : "REAL_DISCOVERY";
  if (discoveryMode === "UNKNOWN") review.add("DISCOVERY_EVIDENCE_REQUIRED");

  const status: DesignBuildHandoffStatus = blocked.size > 0 ? "BLOCKED" :
    review.size > 0 ? "REVIEW_REQUIRED" : "READY_FOR_PREVIEW";
  const body = {
    schemaVersion: 1 as const,
    status, provider, engine,
    designId: design.designId, designHash: design.designHash,
    policyHash: design.policies.bundleHash,
    environmentHash: sha256(JSON.stringify(environment)),
    discoveryMode, evidencePath: design.plugin.evidencePath,
    resourceActions: entries.map((entry) => ({
      resourceId: entry.resourceId, action: entry.action,
      requiresExplicitAuthorization: entry.requiresExplicitAuthorization,
    })),
    blockers: [...blocked].sort(),
    reviewRequired: [...review].sort(),
    infrastructureAct: "DISABLED" as const,
  };
  return { ...body, handoffHash: sha256(JSON.stringify(body)) };
}
