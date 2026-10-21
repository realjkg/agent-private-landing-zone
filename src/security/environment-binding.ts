import { createHash } from "node:crypto";

/**
 * Trusted-host stage and tenant identity. Untrusted models cannot mint a binding.
 * No cloud credentials, authorization or infrastructure ACT authority are carried.
 */
export type Stage = "DEVELOPMENT" | "STAGING" | "PRODUCTION";
export type SovereignProvider = "aws" | "azure" | "gcp" | "private";
export type EnvironmentBinding = Readonly<{
  environmentId: string;
  stage: Stage;
  tenantId: string;
  provider: SovereignProvider;
  targetId: string;
  region: string;
  residency: string;
  identityRef: string;
  capability: "DISCOVER" | "ASSESS" | "DESIGN" | "PREVIEW" | "OPERATE";
}>;

const id = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{2,127}$/;
const geographic = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,63}$/;
function requireValue(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value) || value.includes("..")) {
    throw new Error("ENVIRONMENT_BINDING_INVALID");
  }
  return value;
}

/** Reject unknown keys and missing fields; no provider, tenant or stage inference. */
export function bindEnvironment(raw: unknown): EnvironmentBinding {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("ENVIRONMENT_BINDING_INVALID");
  const obj = raw as Record<string, unknown>;
  const keys = ["environmentId","stage","tenantId","provider","targetId","region","residency","identityRef","capability"];
  if (Object.keys(obj).length !== keys.length || Object.keys(obj).some(k => !keys.includes(k))) {
    throw new Error("ENVIRONMENT_BINDING_INVALID");
  }
  const stage = obj.stage;
  const provider = obj.provider;
  const capability = obj.capability;
  if (!["DEVELOPMENT","STAGING","PRODUCTION"].includes(String(stage)) ||
      !["aws","azure","gcp","private"].includes(String(provider)) ||
      !["DISCOVER","ASSESS","DESIGN","PREVIEW","OPERATE"].includes(String(capability))) {
    throw new Error("ENVIRONMENT_BINDING_INVALID");
  }
  const bound: EnvironmentBinding = {
    environmentId: requireValue(obj.environmentId,id),
    stage: stage as Stage,
    tenantId: requireValue(obj.tenantId,id),
    provider: provider as SovereignProvider,
    targetId: requireValue(obj.targetId,id),
    region: requireValue(obj.region,geographic),
    residency: requireValue(obj.residency,geographic),
    identityRef: requireValue(obj.identityRef,id),
    capability: capability as EnvironmentBinding["capability"],
  };
  return Object.freeze(bound);
}

/** Deterministic subject fingerprint; no secrets or identity material are serialized to evidence. */
export function bindingFingerprint(binding: EnvironmentBinding): string {
  const b = bindEnvironment(binding);
  const ordered = [b.environmentId,b.stage,b.tenantId,b.provider,b.targetId,b.region,b.residency,b.identityRef,b.capability];
  return "sha256:" + createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

/** Fail closed on mismatch, including cross-stage identity or capability reuse. */
export function assertSameEnvironment(expected: EnvironmentBinding, actual: EnvironmentBinding): void {
  if (bindingFingerprint(expected) !== bindingFingerprint(actual)) throw new Error("ENVIRONMENT_SCOPE_MISMATCH");
}

/** Stage promotion cannot reuse a development binding as a production authorization. */
export function requirePromotionReview(source: EnvironmentBinding, destination: EnvironmentBinding): never {
  bindEnvironment(source);
  bindEnvironment(destination);
  throw new Error("PROMOTION_REQUIRES_INDEPENDENT_APPROVAL");
}
