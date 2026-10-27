import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { mutationIdentityVariables } from "../tools/identity.js";
import type { SourceCommit } from "../util/source-commit.js";
import type { EvidenceRunnerConfig } from "./config.js";
import { STAGE_SLICE, type Provider } from "./types.js";

/**
 * The runner's preflight: everything checked before a stage starts. In slice S1 every check is offline: the source
 * checkout, the mutation identities, whether the committed pilot contract authorizes ACT, and the comparison of each provider's observed identity
 * with the expected one. The identity probes themselves ship with their provider's slice (S2 AWS, S3 Azure), so until
 * then a configured provider reports IDENTITY_NOT_VERIFIED and the run stops BLOCKED.
 *
 * Delegated decision 2 (issue #39, 6433391052): a probe may use the operator's existing CLI login only to verify the
 * account and for read-only reads, in process. It never hands a session-bearing value to a child the runner starts.
 */
export type CheckStatus = "PASS" | "BLOCKED" | "INFO";
export type Check = { id: string; status: CheckStatus; code: string; detail: string };

/** How an identity was obtained. The operator's own CLI login is personal-account scope, never organizational qualification. */
export type IdentityKind = "OPERATOR_CLI_LOGIN" | "FEDERATED";
export type IdentityObservation =
  | { status: "OBSERVED"; kind: IdentityKind; accountId?: string; tenantId?: string; subscriptionId?: string }
  | { status: "NOT_SIGNED_IN"; detail: string }
  | { status: "PROBE_NOT_BUILT" };
/** Reads who the provider's login is. Must not return or log token material: ids only. */
export type IdentityProbe = (provider: Provider, config: EvidenceRunnerConfig) => Promise<IdentityObservation>;

/** The S1 probe: none is built yet, so nothing is read from any cloud. */
export const unbuiltProbe: IdentityProbe = async () => ({ status: "PROBE_NOT_BUILT" });

export type IdentityCheck = Check & { provider: Provider; kind?: IdentityKind };

/** Compares what the provider reports with what the configuration expects. Any difference refuses the stage before a read. */
export function compareIdentity(provider: Provider, config: EvidenceRunnerConfig, observed: IdentityObservation): IdentityCheck {
  const id = "identity:" + provider;
  const stage = provider === "aws" ? "aws-readonly" : "azure-readonly";
  if (provider === "aws" && !config.aws || provider === "azure" && !config.azure) {
    return { id, provider, status: "INFO", code: "NOT_CONFIGURED", detail: "No " + provider + " block in the configuration; the " + stage + " stage is skipped." };
  }
  if (observed.status === "PROBE_NOT_BUILT") {
    return { id, provider, status: "BLOCKED", code: "IDENTITY_NOT_VERIFIED",
      detail: "The " + provider + " identity probe ships in slice " + STAGE_SLICE[stage] + "; nothing was read and the stage does not start." };
  }
  if (observed.status === "NOT_SIGNED_IN") {
    return { id, provider, status: "BLOCKED", code: "NOT_SIGNED_IN", detail: observed.detail };
  }
  const mismatches: string[] = [];
  if (provider === "aws") {
    if (observed.accountId !== config.aws!.expectedAccountId) mismatches.push("account " + String(observed.accountId ?? "unknown") + " (expected " + config.aws!.expectedAccountId + ")");
  } else {
    if (observed.tenantId !== config.azure!.expectedTenantId) mismatches.push("tenant " + String(observed.tenantId ?? "unknown") + " (expected " + config.azure!.expectedTenantId + ")");
    if (observed.subscriptionId !== config.azure!.expectedSubscriptionId) mismatches.push("subscription " + String(observed.subscriptionId ?? "unknown") + " (expected " + config.azure!.expectedSubscriptionId + ")");
  }
  if (mismatches.length > 0) {
    return { id, provider, kind: observed.kind, status: "BLOCKED", code: "WRONG_ACCOUNT",
      detail: "Signed in to the wrong " + mismatches.join(" and ") + "; switch accounts and rerun. Nothing was read." };
  }
  return { id, provider, kind: observed.kind, status: "PASS", code: "VERIFIED",
    detail: observed.kind === "OPERATOR_CLI_LOGIN" ? "Your own CLI login, in the expected account (personal-account scope)." : "Federated identity, in the expected account." };
}

/** SHA-256 of the expected ids: binds the journal to the accounts without a credential in it. */
export function identityHash(config: EvidenceRunnerConfig): string {
  return createHash("sha256").update(JSON.stringify({
    aws: config.aws?.expectedAccountId ?? null,
    azure: config.azure ? [config.azure.expectedTenantId, config.azure.expectedSubscriptionId] : null,
  })).digest("hex");
}

/**
 * Whether the committed pilot contract says enabled and carries a non-empty `authorize`, read without loading the apply path.
 * The full contract check is `./alz apply preflight` (slice S5); anything unreadable counts as EMPTY (ACT disabled).
 */
export function authorizationState(root: string): "EMPTY" | "PRESENT" {
  try {
    const contract = JSON.parse(readFileSync(join(root, "config", "act-pilot-contract.json"), "utf8")) as { enabled?: unknown; authorize?: unknown };
    const authorize = contract?.authorize;
    return contract?.enabled === true && !!authorize && typeof authorize === "object" && !Array.isArray(authorize) && Object.keys(authorize).length > 0 ? "PRESENT" : "EMPTY";
  } catch { return "EMPTY"; }
}

/** An input only the owner can supply (delegated decision 3), with the reason the runner prints while it is missing. */
export type OwnerInput = { id: string; status: "BLOCKED" | "INFO"; code: string; detail: string };

export function ownerInputs(config: EvidenceRunnerConfig, authorization: "EMPTY" | "PRESENT"): OwnerInput[] {
  const inputs: OwnerInput[] = [];
  if (config.aws) {
    inputs.push({ id: "aws-noop-stack", status: "BLOCKED", code: "OWNER_INPUT_NOOP_STACK",
      detail: "Create the stack " + config.aws.qualificationStack + " in " + config.aws.expectedAccountId + "/" + config.aws.region +
        " by hand from qualification/provider/aws-noop-stack.yaml. The runner only verifies it, read-only (slice S2), and never creates, updates or deletes it." });
  }
  if (config.aws || config.azure) {
    inputs.push({ id: "federated-qualification-identity", status: "BLOCKED", code: "OWNER_INPUT_FEDERATED_IDENTITY",
      detail: "The aws-provider and azure-provider gates run ./alz qualify provider-aws|provider-azure under the federated qualification identity, never under your CLI login; the runner reports them BLOCKED until it is configured (checked in slices S2 and S3)." });
  }
  inputs.push(authorization === "EMPTY"
    ? { id: "pilot-authorization", status: "BLOCKED", code: "OWNER_INPUT_AUTHORIZATION",
      detail: "The preview:* and act:* gates are produced after the owner's reviewed commit of the pilot contract with its authorize entry (docs/act-pilot-plan.md). ACT is disabled; the act stage is skipped." }
    : { id: "pilot-authorization", status: "INFO", code: "AUTHORIZATION_PRESENT",
      detail: "The committed contract says enabled and has an authorize entry (read for shape only, not validated). ./alz apply preflight checks the contract in full, and the kill switch, before any guided step (slice S5)." });
  return inputs;
}

export type PreflightInputs = {
  root: string;
  env: NodeJS.ProcessEnv;
  config: EvidenceRunnerConfig;
  source: SourceCommit;
  probe: IdentityProbe;
};
export type Preflight = { checks: Check[]; identities: IdentityCheck[]; ownerInputs: OwnerInput[]; actScope: "EMPTY" | "PRESENT"; blocked: boolean };

export async function runPreflight({ root, env, config, source, probe }: PreflightInputs): Promise<Preflight> {
  const checks: Check[] = [];
  if (!source.ok) checks.push({ id: "source", status: "BLOCKED", code: "SOURCE_NOT_CLEAN", detail: source.reason });
  else if (source.commit !== config.candidateCommit) {
    checks.push({ id: "source", status: "BLOCKED", code: "CANDIDATE_NOT_HEAD",
      detail: "HEAD is " + source.commit.slice(0, 12) + " but the configuration names candidate " + config.candidateCommit.slice(0, 12) + "; check out the candidate." });
  } else checks.push({ id: "source", status: "PASS", code: "CANDIDATE_IS_HEAD", detail: "Clean checkout of candidate " + source.commit.slice(0, 12) + "." });
  const mutation = mutationIdentityVariables(env);
  checks.push(mutation.length > 0
    ? { id: "mutation-identities", status: "BLOCKED", code: "MUTATION_IDENTITY_PRESENT",
      detail: "Unset " + mutation.join(", ") + " first: read-only stages never run beside an identity that can write." }
    : { id: "mutation-identities", status: "PASS", code: "NONE", detail: "No apply, state-write or change-set identity is set." });
  const authorization = authorizationState(root);
  checks.push({ id: "act", status: "INFO", code: authorization === "EMPTY" ? "SKIPPED_ACT_DISABLED" : "AUTHORIZATION_PRESENT",
    detail: authorization === "EMPTY" ? "No committed contract authorizes ACT: ACT is disabled and the act stage is skipped." : "The committed contract says enabled and has an authorize entry (shape only, not validated); ./alz apply preflight checks it in full (slice S5)." });
  const identities: IdentityCheck[] = [];
  for (const provider of ["aws", "azure"] as const) {
    const configured = provider === "aws" ? config.aws : config.azure;
    // No probe runs for a provider the configuration does not name.
    identities.push(compareIdentity(provider, config, configured ? await probe(provider, config) : { status: "PROBE_NOT_BUILT" }));
  }
  const blocked = [...checks, ...identities].some((check) => check.status === "BLOCKED");
  return { checks, identities, ownerInputs: ownerInputs(config, authorization), actScope: authorization, blocked };
}
