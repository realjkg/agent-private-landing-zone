/**
 * Cross-platform qualification contract for Studio → private ALZ.
 *
 * Checks prerequisites only. Does not verify JWTs, make network requests,
 * exchange SSO credentials, start an MCP server, or assert a working connection.
 */
export type RuntimePlatform = "linux/arm64" | "linux/amd64";
export type StudioPrerequisites = {
  platform: string;
  arch: string;
  modelEndpoint: string;
  modelLocalOnly: boolean;
  mcpIngress: "PRIVATE_AUTHENTICATED" | "PUBLIC" | "NOT_CONFIGURED";
  sso: "OIDC_VERIFIED_BY_TRUSTED_GATEWAY" | "UNVERIFIED" | "NOT_CONFIGURED";
  audienceRestricted: boolean;
  subagentScopesRestricted: boolean;
};
export type PrerequisiteReport = {
  supportedPlatform: RuntimePlatform | null;
  eligibleForLiveQualification: boolean;
  missing: string[];
  /** Intentionally never asserts authentication succeeded or Studio is reachable. */
  evidence: "LOCAL_CONFIGURATION_ONLY";
};

export function assessStudioPrerequisites(p: StudioPrerequisites): PrerequisiteReport {
  const supportedPlatform: RuntimePlatform | null = p.platform === "linux" && p.arch === "arm64"
    ? "linux/arm64"
    : p.platform === "linux" && p.arch === "x64" ? "linux/amd64" : null;
  const missing: string[] = [];
  if (!supportedPlatform) missing.push("LINUX_ARCH_NOT_SUPPORTED");
  if (!p.modelLocalOnly) missing.push("LOCAL_MODEL_POLICY_NOT_ENFORCED");
  try {
    const u = new URL(p.modelEndpoint);
    const local = u.protocol === "http:" &&
      (u.hostname === "127.0.0.1" || u.hostname === "[::1]" || u.hostname === "localhost") &&
      !u.username && !u.password && !u.hash;
    if (!local) missing.push("LOCAL_MODEL_ENDPOINT_REQUIRED");
  } catch {
    missing.push("LOCAL_MODEL_ENDPOINT_INVALID");
  }
  if (p.mcpIngress !== "PRIVATE_AUTHENTICATED") missing.push("PRIVATE_AUTHENTICATED_MCP_INGRESS_REQUIRED");
  if (p.sso !== "OIDC_VERIFIED_BY_TRUSTED_GATEWAY") missing.push("TRUSTED_SSO_VERIFIER_REQUIRED");
  if (!p.audienceRestricted) missing.push("TOKEN_AUDIENCE_RESTRICTION_REQUIRED");
  if (!p.subagentScopesRestricted) missing.push("SUBAGENT_SCOPE_RESTRICTION_REQUIRED");
  return {
    supportedPlatform,
    eligibleForLiveQualification: missing.length === 0,
    missing,
    evidence: "LOCAL_CONFIGURATION_ONLY"
  };
}

/** A supported CPU ABI does not establish working SSO, MCP or local inference. */
export function inspectContainerAbi(): { platform: string; arch: string; node: string } {
  return { platform: process.platform, arch: process.arch, node: process.versions.node };
}
