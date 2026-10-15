import { createHash } from "node:crypto";
import type { BrownfieldProvider, PolicyRef } from "./brownfield-reuse.js";

/**
 * Bounded offline checks for NATIVE POLICY JSON. These checks identify selected
 * high-risk configurations, not equivalent policy evaluation / OPA / compliance.
 */
export type NativePolicyFormat =
  | "AWS_IDENTITY_POLICY_JSON" | "AWS_SECURITY_GROUP_JSON"
  | "AZURE_POLICY_ASSIGNMENT_JSON" | "GCP_ORG_POLICY_JSON";
export type NativePolicyDocument = {
  controlId: string;
  format: NativePolicyFormat;
  /** Exact bytes from a separately trusted source; JSON key order matters for hash. */
  content: string;
};
export type NativePolicyFinding = {
  controlId: string;
  status: "REJECT" | "REVIEW" | "STRUCTURALLY_ACCEPTABLE";
  reasons: string[];
  contentSha256: string;
};
const JSON_LIMIT = 256_000;
const BAD_CIDRS = new Set(["0.0.0.0/0", "::/0"]);
const ADMIN_PORTS = new Set([22, 3389]);
const asObj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : v == null ? [] : [v];
const hasAny = (v: unknown, part: string) => list(v).some((x) => typeof x === "string" && (x === "*" || x.toLowerCase() === part));

export function inspectNativePolicyJson(
  provider: BrownfieldProvider,
  ref: PolicyRef,
  document: NativePolicyDocument,
): NativePolicyFinding {
  const reject: string[] = [];
  const review: string[] = [];
  const digest = createHash("sha256").update(document?.content ?? "").digest("hex");
  if (!document || typeof document.content !== "string" || document.content.length > JSON_LIMIT ||
    ref.id !== document.controlId || digest !== ref.definitionSha256) {
    reject.push("Native document is missing, too large, has a mismatched identity, or fails the source-definition digest.");
  }
  const compatible: Record<NativePolicyFormat, [BrownfieldProvider, string]> = {
    AWS_IDENTITY_POLICY_JSON: ["AWS", "IAM_POLICY"],
    AWS_SECURITY_GROUP_JSON: ["AWS", "SECURITY_GROUP"],
    AZURE_POLICY_ASSIGNMENT_JSON: ["AZURE", "AZURE_POLICY_ASSIGNMENT"],
    GCP_ORG_POLICY_JSON: ["GCP", "ORGANIZATION_POLICY"],
  };
  const expected = document ? compatible[document.format] : undefined;
  if (!expected || expected[0] !== provider || expected[1] !== ref.family) {
    reject.push("Native document format cannot claim authority for the given provider and policy family.");
  }
  let parsed: unknown;
  if (reject.length === 0) {
    try { parsed = JSON.parse(document.content); }
    catch { reject.push("Native policy JSON could not be parsed."); }
  }
  const root = asObj(parsed);
  if (reject.length === 0 && !root) reject.push("Native policy root must be an object.");
  if (reject.length === 0 && root) {
    switch (document.format) {
      case "AWS_IDENTITY_POLICY_JSON": {
        const statements = list(root.Statement);
        if (root.Version !== "2012-10-17" || statements.length === 0) {
          reject.push("AWS IAM document lacks expected policy Version/Statements.");
          break;
        }
        for (const raw of statements) {
          const stmt = asObj(raw);
          if (!stmt || typeof stmt.Effect !== "string" || stmt.Effect !== "Allow" && stmt.Effect !== "Deny") {
            reject.push("IAM statement is malformed."); continue;
          }
          if (stmt.Effect === "Allow") {
            const broadAction = hasAny(stmt.Action, "iam:*") || hasAny(stmt.Action, "*");
            const broadResource = hasAny(stmt.Resource, "*");
            if (broadAction && broadResource)
              reject.push("Identity policy permits wildcard actions against wildcard resources.");
            if (stmt.Principal === "*" && broadResource)
              reject.push("Identity policy includes unrestricted principals and resources.");
          }
          if (stmt.Condition && !asObj(stmt.Condition)) review.push("IAM policy has a condition that requires native evaluation.");
        }
        review.push("Identity permission boundaries, role trust and effective grants require account-aware verification.");
        break;
      }
      case "AWS_SECURITY_GROUP_JSON": {
        const perms = list(root.IpPermissions ?? root.SecurityGroupIngress);
        if (perms.length === 0) review.push("No inbound rules provided; completeness requires live read-only inventory.");
        for (const raw of perms) {
          const ingress = asObj(raw);
          if (!ingress) { reject.push("Malformed security-group ingress rule."); continue; }
          const cidrs = [
            ...list(ingress.IpRanges).map((v) => asObj(v)?.CidrIp),
            ...list(ingress.Ipv6Ranges).map((v) => asObj(v)?.CidrIpv6),
            ingress.CidrIp, ingress.CidrIpv6,
          ];
          const world = cidrs.some((v) => typeof v === "string" && BAD_CIDRS.has(v));
          const first = Number(ingress.FromPort);
          const last = Number(ingress.ToPort);
          const allProtocols = ingress.IpProtocol === "-1";
          if (world && (allProtocols || [...ADMIN_PORTS].some((port) =>
            Number.isFinite(first) && Number.isFinite(last) && first <= port && last >= port)))
            reject.push("World-reachable administrative ports or all-protocol ingress detected.");
          else if (world) review.push("Public ingress requires explicit service exposure authorization and target-specific rule review.");
        }
        review.push("Outbound rules, attachment scope and effective network policies need independent verification.");
        break;
      }
      case "AZURE_POLICY_ASSIGNMENT_JSON": {
        const prop = asObj(root.properties);
        if (!prop || typeof prop.policyDefinitionId !== "string" || prop.policyDefinitionId.length === 0) {
          reject.push("Azure policy assignment missing policyDefinitionId."); break;
        }
        const mode = prop.enforcementMode;
        if (mode === "DoNotEnforce") reject.push("Azure Policy assignment uses DoNotEnforce.");
        else if (mode === "Enroll" || mode == null) review.push("Azure Policy enrollment or enforcement status must be verified at target scope.");
        else if (mode !== "Default") reject.push("Unknown Azure Policy enforcement mode.");
        if (Array.isArray(prop.notScopes) && prop.notScopes.length > 0) review.push("Azure Policy notScopes may exclude target resources.");
        if (Array.isArray(prop.resourceSelectors) && prop.resourceSelectors.length > 0)
          review.push("Azure Policy resource selectors require target-specific evaluation.");
        if (Array.isArray(prop.overrides) && prop.overrides.length > 0)
          review.push("Azure Policy overrides and exemptions require policy-owner validation.");
        review.push("Effective assignment, initiative effects, exemptions and compliance require Azure Policy evaluation.");
        break;
      }
      case "GCP_ORG_POLICY_JSON": {
        const spec = asObj(root.spec);
        if (!spec || !Array.isArray(spec.rules) || spec.rules.length === 0) {
          reject.push("GCP Organization Policy spec contains no enforceable rules."); break;
        }
        if (spec.reset === true) reject.push("GCP Organization Policy resets to inherited defaults without verified effective constraint.");
        for (const raw of spec.rules) {
          const rule = asObj(raw);
          if (!rule) { reject.push("Malformed GCP Organization Policy rule."); continue; }
          const values = asObj(rule.values);
          if (rule.allowAll === true || rule.enforce === false || values?.allowedValues === "*")
            reject.push("GCP Organization Policy rule explicitly permits unrestricted values or disables enforcement.");
          if (rule.condition) review.push("Conditional GCP Organization Policy rule must be evaluated against the target resource.");
          if (rule.enforce === undefined && !rule.denyAll && !values)
            review.push("GCP policy rule semantics are incomplete for offline structural analysis.");
        }
        review.push("Effective inherited constraints and folder/project overrides require Organization Policy evidence.");
        break;
      }
    }
  }
  return {
    controlId: ref.id,
    status: reject.length ? "REJECT" : review.length ? "REVIEW" : "STRUCTURALLY_ACCEPTABLE",
    reasons: [...reject, ...review],
    contentSha256: digest,
  };
}
