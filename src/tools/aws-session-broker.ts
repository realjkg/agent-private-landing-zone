/**
 * AWS broker admission boundary for the existing ALZ operator and adapters.
 * The trusted host owns SSO/workload credential resolution and STS validation.
 * Models only receive the sanitized verdict and local evidence reference.
 */
export type AwsStage = "DEV" | "STAGING" | "PROD";
export type AwsEngine = "TERRAFORM" | "CDK";
export type AwsCapability = "DISCOVERY_READ" | "IAC_PLAN" | "CHANGESET_PREVIEW";
export type AwsSessionKind = "SSO" | "WORKLOAD_OIDC";
export type AwsBrokerRequest = {
  requestId: string;
  operatorId: string;
  stage: AwsStage;
  accountId: string;
  region: string;
  roleArn: string;
  engine: AwsEngine;
  capability: AwsCapability;
};
export type AwsAdapterResult = {
  status: "OK" | "REVIEW_REQUIRED";
  evidenceRef: string;
};
/**
 * Construct ONLY inside a trusted host-owned credential provider after STS
 * identity verification. It is a broker interface, NOT a STS attestation.
 * invoke must use that same verified session (not ambient credentials).
 */
export type VerifiedAwsSession = {
  trust: "STS_VERIFIED_BY_HOST";
  kind: AwsSessionKind;
  accountId: string;
  region: string;
  roleArn: string;
  stage: AwsStage;
  operatorId: string;
  expiresAtEpochMs: number;
  capabilities: readonly AwsCapability[];
  invoke: (capability: AwsCapability, engine: AwsEngine) => Promise<AwsAdapterResult>;
};
export type AwsTrustedSessionResolver = {
  resolve: (request: Readonly<AwsBrokerRequest>) => Promise<VerifiedAwsSession | null>;
};
export type AwsBrokerDenyCode =
  "INVALID_REQUEST" | "SESSION_UNAVAILABLE" | "SESSION_UNTRUSTED" |
  "SESSION_EXPIRED" | "ACCOUNT_MISMATCH" | "REGION_MISMATCH" |
  "ROLE_MISMATCH" | "STAGE_MISMATCH" | "OPERATOR_MISMATCH" |
  "CAPABILITY_DENIED" | "ENGINE_CAPABILITY_MISMATCH" | "ADAPTER_FAILED";
export type AwsBrokerResult =
  | { allowed: true; status: AwsAdapterResult["status"]; evidenceRef: string; requestId: string; capability: AwsCapability }
  | { allowed: false; code: AwsBrokerDenyCode; requestId: string };

const ACCOUNT = /^[0-9]{12}$/;
const REGION = /^(?:us|eu|ap|sa|ca|me|af|il|cn)(?:-gov)?-[a-z0-9-]+-[1-9][0-9]*$/;
const ROLE = /^arn:(aws|aws-us-gov|aws-cn):iam::([0-9]{12}):role\/(?:[A-Za-z0-9_+=,.@-]+\/)*[A-Za-z0-9_+=,.@-]+$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EVIDENCE = /^evidence:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/;
const STAGES: readonly AwsStage[] = ["DEV", "STAGING", "PROD"];
const ENGINES: readonly AwsEngine[] = ["TERRAFORM", "CDK"];
const CAPABILITIES: readonly AwsCapability[] = ["DISCOVERY_READ", "IAC_PLAN", "CHANGESET_PREVIEW"];
const KINDS: readonly AwsSessionKind[] = ["SSO", "WORKLOAD_OIDC"];
const MIN_LIFETIME_MS = 30_000;
const MAX_LIFETIME_MS = 12 * 60 * 60 * 1000;
function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}
function roleParts(value: string): RegExpExecArray | null { return ROLE.exec(value); }
function engineAllows(engine: AwsEngine, capability: AwsCapability): boolean {
  return capability === "DISCOVERY_READ" ||
    (engine === "TERRAFORM" && capability === "IAC_PLAN") ||
    (engine === "CDK" && capability === "CHANGESET_PREVIEW");
}
function deny(code: AwsBrokerDenyCode, requestId: string): AwsBrokerResult {
  return { allowed: false, code, requestId };
}
function validRequest(request: AwsBrokerRequest): boolean {
  if (!request || typeof request !== "object") return false;
  const role = typeof request.roleArn === "string" ? roleParts(request.roleArn) : null;
  return typeof request.requestId === "string" && IDENTIFIER.test(request.requestId) &&
    typeof request.operatorId === "string" && IDENTIFIER.test(request.operatorId) &&
    ACCOUNT.test(request.accountId ?? "") && REGION.test(request.region ?? "") &&
    !!role && role[2] === request.accountId &&
    isOneOf(STAGES, request.stage) && isOneOf(ENGINES, request.engine) &&
    isOneOf(CAPABILITIES, request.capability);
}
/** Strict identity admission and one operation; no credential returns and no ACT. */
export async function executeScopedAwsOperation(
  request: AwsBrokerRequest,
  resolver: AwsTrustedSessionResolver,
  options: { now?: () => number } = {},
): Promise<AwsBrokerResult> {
  const id = typeof request?.requestId === "string" && IDENTIFIER.test(request.requestId) ? request.requestId : "invalid";
  if (!validRequest(request)) return deny("INVALID_REQUEST", id);
  if (!engineAllows(request.engine, request.capability)) return deny("ENGINE_CAPABILITY_MISMATCH", id);
  let session: VerifiedAwsSession | null;
  try {
    session = await resolver.resolve(Object.freeze({ ...request }));
  } catch {
    return deny("SESSION_UNAVAILABLE", id);
  }
  if (!session) return deny("SESSION_UNAVAILABLE", id);
  if (session.trust !== "STS_VERIFIED_BY_HOST" || !isOneOf(KINDS, session.kind) ||
      typeof session.invoke !== "function" ||
      !Array.isArray(session.capabilities) ||
      session.capabilities.some(c => !isOneOf(CAPABILITIES, c))) {
    return deny("SESSION_UNTRUSTED", id);
  }
  const now = (options.now ?? Date.now)();
  if (!Number.isFinite(now) || !Number.isSafeInteger(session.expiresAtEpochMs) ||
      session.expiresAtEpochMs - now < MIN_LIFETIME_MS ||
      session.expiresAtEpochMs - now > MAX_LIFETIME_MS)
    return deny("SESSION_EXPIRED", id);
  if (session.accountId !== request.accountId) return deny("ACCOUNT_MISMATCH", id);
  if (session.region !== request.region) return deny("REGION_MISMATCH", id);
  if (session.roleArn !== request.roleArn || !roleParts(session.roleArn) ||
      roleParts(session.roleArn)![2] !== request.accountId) return deny("ROLE_MISMATCH", id);
  if (session.stage !== request.stage) return deny("STAGE_MISMATCH", id);
  if (session.operatorId !== request.operatorId) return deny("OPERATOR_MISMATCH", id);
  if (!session.capabilities.includes(request.capability)) return deny("CAPABILITY_DENIED", id);
  // The trusted resolver retains secrets inside invoke. Neither the exception
  // text nor the adapter's raw AWS output crosses this boundary.
  try {
    const result = await session.invoke(request.capability, request.engine);
    if (!result || !["OK", "REVIEW_REQUIRED"].includes(result.status) ||
        typeof result.evidenceRef !== "string" || !EVIDENCE.test(result.evidenceRef) ||
        result.evidenceRef.includes("..")) return deny("ADAPTER_FAILED", id);
    return { allowed:true, requestId:id, capability:request.capability,
      status:result.status, evidenceRef:result.evidenceRef };
  } catch {
    return deny("ADAPTER_FAILED", id);
  }
}
