import { createHash } from "node:crypto";
import type { BrownfieldProvider, PolicyRef } from "./brownfield-reuse.js";

/**
 * Offline normalization of customer-exported cloud policy read responses.
 * No cloud SDKs, credentials, network, native policy execution, or ACT.
 * A matching hash proves bytes match the submitted hash, NOT source authenticity.
 */
export const SNAPSHOT_METHODS = [
  "AWS_CONTROL_TOWER_GET_ENABLED_CONTROL",
  "AZURE_POLICY_ASSIGNMENT_GET",
  "GCP_ORGPOLICY_GET_EFFECTIVE_POLICY",
] as const;
export type SnapshotMethod = typeof SNAPSHOT_METHODS[number];
export type CloudPolicySnapshot = {
  controlId: string;
  provider: BrownfieldProvider;
  method: SnapshotMethod;
  /** Target account/OU, subscription/resource, or GCP project/folder/org being assessed. */
  targetScope: string;
  /** Customer-provided native JSON response, never displayed in output or logs. */
  content: string;
  contentSha256: string;
  /** An explicit complete-capture claim, not independently attested. */
  inventoryComplete: boolean;
};
export type PolicySnapshotAssessment = {
  controlId: string;
  verdict: "BLOCK" | "REVIEW" | "SOURCE_CONSISTENT_REQUIRES_ATTESTATION";
  reasons: string[];
  sourceDigestMatched: boolean;
  providerCalls: 0;
  attested: false;
  actAllowed: false;
  evidenceKind: "CUSTOMER_EXPORTED_CLOUD_READ_NOT_ATTESTED";
  evidenceSha256: string;
};

const methodFamily: Record<SnapshotMethod, [BrownfieldProvider, string]> = {
  AWS_CONTROL_TOWER_GET_ENABLED_CONTROL: ["AWS", "CONTROL_TOWER_CONTROL"],
  AZURE_POLICY_ASSIGNMENT_GET: ["AZURE", "AZURE_POLICY_ASSIGNMENT"],
  GCP_ORGPOLICY_GET_EFFECTIVE_POLICY: ["GCP", "ORGANIZATION_POLICY"],
};
const obj = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const safe = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 2048 && !/[\x00-\x1F]/.test(value);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const azureScopeContains = (ancestor: string, target: string) => {
  const a = ancestor.replace(/\/$/, "").toLowerCase();
  const b = target.replace(/\/$/, "").toLowerCase();
  return b === a || b.startsWith(a + "/");
};

export function inspectCloudPolicySnapshot(
  ref: PolicyRef,
  provider: BrownfieldProvider,
  targetScope: string,
  snapshot: CloudPolicySnapshot,
): PolicySnapshotAssessment {
  const block: string[] = [];
  const review: string[] = [];
  const content = snapshot?.content;
  const digest = typeof content === "string" ? sha(content) : "";
  const method = snapshot && SNAPSHOT_METHODS.includes(snapshot.method) ? snapshot.method : undefined;
  const supported = method ? methodFamily[method] : undefined;
  if (!snapshot || !safe(snapshot.controlId) || snapshot.controlId !== ref.id ||
    snapshot.provider !== provider || !supported || supported[0] !== provider || supported[1] !== ref.family) {
    block.push("Snapshot provider, method, or control identity is not bound to the declared native control.");
  }
  if (!safe(targetScope) || !safe(snapshot?.targetScope) || snapshot.targetScope !== targetScope)
    block.push("Exported read target does not exactly match the intended application target.");
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > 256_000 ||
    !/^[0-9a-f]{64}$/.test(snapshot?.contentSha256 ?? "") || digest !== snapshot.contentSha256)
    block.push("Customer-exported response is missing, oversized, or fails its transport digest.");
  if (snapshot?.inventoryComplete !== true)
    review.push("Customer's exported control/inventory completeness has not been established.");
  let root: Record<string, unknown> | undefined;
  if (block.length === 0) {
    try { root = obj(JSON.parse(content as string)); }
    catch { block.push("Native response is not valid JSON."); }
    if (!root) block.push("Native policy response must be a JSON object.");
  }
  if (root && method === "AWS_CONTROL_TOWER_GET_ENABLED_CONTROL") {
    const control = obj(root.enabledControlDetails);
    const summary = obj(control?.statusSummary);
    const drift = obj(control?.driftStatusSummary);
    if (!control || control.arn !== ref.id || !safe(control.targetIdentifier) ||
      control.targetIdentifier !== targetScope) block.push("Control Tower enabled-control ARN or target OU differs from the manifest.");
    if (summary?.status === "FAILED") block.push("Control Tower enabled-control deployment failed.");
    else if (summary?.status !== "SUCCEEDED") review.push("Control Tower enablement is not in a confirmed SUCCEEDED state.");
    if (drift?.driftStatus === "DRIFTED") block.push("Control Tower reports control drift.");
    else if (drift?.driftStatus !== "IN_SYNC") review.push("Control Tower resource/inheritance drift status is not confirmed IN_SYNC.");
    review.push("Enabled OU controls do not prove application account membership, actual enforcement behavior, or exception-free coverage.");
  } else if (root && method === "AZURE_POLICY_ASSIGNMENT_GET") {
    const props = obj(root.properties);
    if (!safe(root.id) || root.id.toLowerCase() !== ref.id.toLowerCase() ||
      !props || !safe(props.scope)) block.push("Azure Policy assignment ID or scope is missing or inconsistent.");
    else {
      if (!azureScopeContains(props.scope, targetScope))
        block.push("Azure Policy assignment is outside the target resource hierarchy.");
      if (safe(ref.assignedScope) && props.scope.toLowerCase() !== ref.assignedScope.toLowerCase())
        block.push("Azure Policy assignment source scope differs from the declared policy scope.");
    }
    if (!safe(props?.policyDefinitionId)) block.push("Azure Policy assignment definition is missing.");
    if (props?.enforcementMode === "DoNotEnforce")
      block.push("Azure Policy assignment is configured DoNotEnforce.");
    else if (props?.enforcementMode === "Enroll")
      review.push("Azure Policy enrollment must be independently proved before enforcement.");
    else if (props?.enforcementMode !== "Default")
      review.push("Azure Policy enforcementMode is not explicitly Default.");
    if (arr(props?.notScopes).some((s) => typeof s === "string" && azureScopeContains(s, targetScope)))
      block.push("Azure Policy notScopes explicitly excludes the target.");
    if (arr(props?.resourceSelectors).length || arr(props?.overrides).length)
      review.push("Azure Policy selectors or effect overrides require target-specific evaluation.");
    review.push("Azure Policy effective initiatives, exemptions, enrollment, and compliance are not established by assignment GET.");
  } else if (root && method === "GCP_ORGPOLICY_GET_EFFECTIVE_POLICY") {
    const expected = targetScope + "/policies/";
    if (!safe(root.name) || root.name !== ref.id || !root.name.startsWith(expected))
      block.push("GCP effective policy response name is not scoped to the exact target.");
    const spec = obj(root.spec);
    const rules = arr(spec?.rules);
    if (!spec || rules.length === 0)
      block.push("GCP effective organization policy has no enforceable rule set.");
    if (spec?.reset === true) block.push("GCP organization policy resets inherited constraints.");
    for (const raw of rules) {
      const rule = obj(raw);
      if (!rule) { block.push("Malformed GCP effective policy rule."); continue; }
      if (rule.allowAll === true || rule.enforce === false)
        block.push("GCP effective policy explicitly permits all values or disables enforcement.");
      if (rule.condition !== undefined)
        review.push("Conditional rule appeared in purported GetEffectivePolicy response; provenance or evaluation is uncertain.");
      if (rule.enforce !== true && rule.denyAll !== true && !obj(rule.values))
        review.push("GCP effective policy rule requires constraint-specific semantic evaluation.");
      if (obj(rule.values))
        review.push("GCP list constraint value/default behavior requires native constraint-aware validation.");
    }
    review.push("Exported GetEffectivePolicy response cannot independently attest API provenance, target IAM or compliance.");
  }
  const reasons = [...new Set([...block, ...review])].sort();
  const verdict = block.length ? "BLOCK" as const :
    review.length ? "REVIEW" as const : "SOURCE_CONSISTENT_REQUIRES_ATTESTATION" as const;
  const canonical = {
    controlId: ref.id, verdict, reasons,
    sourceDigestMatched: block.length === 0 && digest === snapshot.contentSha256,
    providerCalls: 0 as const, attested: false as const, actAllowed: false as const,
    evidenceKind: "CUSTOMER_EXPORTED_CLOUD_READ_NOT_ATTESTED" as const,
  };
  return { ...canonical, evidenceSha256: sha(JSON.stringify(canonical)) };
}
