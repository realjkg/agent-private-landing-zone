import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { mutationIdentityVariables } from "../tools/identity.js";
import type { SourceCommit } from "../util/source-commit.js";
import type { EvidenceRunnerConfig } from "./config.js";
import { CONTRACT_PATH } from "./source.js";
import { ACT_PATH_SPEC, PROVIDERS, READONLY_STAGES, READONLY_STAGE_OF, isGuidedStage, type ActPathId, type Provider, type StageId } from "./types.js";

/**
 * The runner's preflight: everything checked before a stage starts, offline and in this process. The source checkout; that no
 * mutation identity sits beside a read-only stage; what the committed pilot contract authorizes (its shape only: the full check
 * is the `./alz apply contract-check` and `preflight` children of the guided stages); and, for each provider whose read-only
 * stage is selected, the federated identity's identifiers against the expected account, tenant, subscription or project
 * (`identity.ts`). Nothing here reads a token, calls a cloud or uses the operator's own CLI login.
 */
export type CheckStatus = "PASS" | "BLOCKED" | "INFO";
export type Check = { id: string; status: CheckStatus; code: string; detail: string };

/**
 * How an identity was obtained. `FEDERATED`: the pilot's federated DISCOVERY identity, the only kind this build's probe
 * reports. `OPERATOR_CLI_LOGIN` (decision 2) is not used by this build; the kind stays so a record can never be mistaken.
 */
export type IdentityKind = "OPERATOR_CLI_LOGIN" | "FEDERATED";
export type IdentityObservation =
  | { status: "OBSERVED"; kind: IdentityKind; accountId?: string; tenantId?: string; subscriptionId?: string; projectId?: string; region?: string }
  | { status: "NOT_SIGNED_IN"; detail: string }
  | { status: "MISSING"; detail: string }
  | { status: "REFUSED"; detail: string }
  | { status: "PROBE_NOT_BUILT" };
/** Reads who the provider identity is. Must not return or log token material: ids only. */
export type IdentityProbe = (provider: Provider, config: EvidenceRunnerConfig) => Promise<IdentityObservation>;

/** A probe that reads nothing: every configured provider stays unverified. For tests of the refusal. */
export const unbuiltProbe: IdentityProbe = async () => ({ status: "PROBE_NOT_BUILT" });

export type IdentityCheck = Check & { provider: Provider; kind?: IdentityKind; observed?: { accountId?: string; tenantId?: string; subscriptionId?: string; projectId?: string } };

const targetOf = (provider: Provider, config: EvidenceRunnerConfig) => provider === "aws" ? config.aws : provider === "azure" ? config.azure : config.gcp;

/** Compares what the identity names with what the configuration expects. Any difference refuses the stage before a read. */
export function compareIdentity(provider: Provider, config: EvidenceRunnerConfig, observed: IdentityObservation): IdentityCheck {
  const id = "identity:" + provider;
  const stage = READONLY_STAGE_OF[provider];
  if (!targetOf(provider, config)) {
    return { id, provider, status: "INFO", code: "NOT_CONFIGURED", detail: "No " + provider + " block in the configuration; the " + stage + " stage is skipped." };
  }
  if (observed.status === "PROBE_NOT_BUILT") {
    return { id, provider, status: "BLOCKED", code: "IDENTITY_NOT_VERIFIED", detail: "No identity probe ran for " + provider + "; nothing was read and the stage does not start." };
  }
  if (observed.status === "NOT_SIGNED_IN") return { id, provider, status: "BLOCKED", code: "NOT_SIGNED_IN", detail: observed.detail };
  if (observed.status === "MISSING") return { id, provider, status: "BLOCKED", code: "FEDERATED_IDENTITY_MISSING", detail: observed.detail };
  if (observed.status === "REFUSED") return { id, provider, status: "BLOCKED", code: "IDENTITY_NOT_FEDERATED", detail: observed.detail };
  const mismatches: string[] = [];
  const differs = (what: string, seen: string | undefined, expected: string) => { if (seen !== expected) mismatches.push(what + " " + String(seen ?? "unknown") + " (expected " + expected + ")"); };
  if (provider === "aws") {
    differs("account", observed.accountId, config.aws!.expectedAccountId);
    if (observed.region !== undefined) differs("region", observed.region, config.aws!.region);
  } else if (provider === "azure") {
    differs("tenant", observed.tenantId, config.azure!.expectedTenantId);
    differs("subscription", observed.subscriptionId, config.azure!.expectedSubscriptionId);
  } else {
    differs("project", observed.projectId, config.gcp!.expectedProjectId);
    if (observed.region !== undefined) differs("region", observed.region, config.gcp!.region);
  }
  const ids = { accountId: observed.accountId, tenantId: observed.tenantId, subscriptionId: observed.subscriptionId, projectId: observed.projectId };
  const observedIds = Object.fromEntries(Object.entries(ids).filter(([, value]) => value !== undefined));
  if (mismatches.length > 0) {
    return { id, provider, kind: observed.kind, observed: observedIds, status: "BLOCKED", code: "WRONG_ACCOUNT",
      detail: "The identity names the wrong " + mismatches.join(" and ") + "; fix the identity or the configuration and rerun. Nothing was read." };
  }
  return { id, provider, kind: observed.kind, observed: observedIds, status: "PASS", code: "VERIFIED",
    detail: observed.kind === "OPERATOR_CLI_LOGIN" ? "Your own CLI login, in the expected account (personal-account scope)."
      : "The federated DISCOVERY identity names the expected " + (provider === "aws" ? "account" : provider === "azure" ? "tenant and subscription" : "project") +
        " (its identifiers, before any read; the producer's own token exchange is the cloud's answer)." };
}

/** SHA-256 of the expected ids: binds the journal to the accounts without a credential in it. */
export function identityHash(config: EvidenceRunnerConfig): string {
  return createHash("sha256").update(JSON.stringify({
    aws: config.aws?.expectedAccountId ?? null,
    azure: config.azure ? [config.azure.expectedTenantId, config.azure.expectedSubscriptionId] : null,
    // Added with the GCP stage; absent keeps the hash of a configuration without GCP unchanged.
    ...(config.gcp ? { gcp: config.gcp.expectedProjectId } : {}),
  })).digest("hex");
}

/**
 * What the committed pilot contract says, read for shape only and without loading the apply path: whether it is enabled with a
 * non-empty `authorize`, the provider and engine it names, and the operations it authorizes in DEV. Anything unreadable counts
 * as EMPTY (ACT disabled). The full contract check is the `./alz apply contract-check` and `preflight` children.
 */
export type ContractScope = { state: "EMPTY" } | { state: "PRESENT"; provider?: string; engine?: string; dev: string[] };
export function contractScope(root: string): ContractScope {
  try {
    const contract = JSON.parse(readFileSync(join(root, CONTRACT_PATH), "utf8")) as { enabled?: unknown; authorize?: unknown; provider?: unknown; engine?: unknown };
    const authorize = contract?.authorize;
    if (contract?.enabled !== true || !authorize || typeof authorize !== "object" || Array.isArray(authorize) || Object.keys(authorize).length === 0) return { state: "EMPTY" };
    const dev = (authorize as Record<string, unknown>).DEV;
    return {
      state: "PRESENT",
      ...(typeof contract.provider === "string" ? { provider: contract.provider } : {}),
      ...(typeof contract.engine === "string" ? { engine: contract.engine } : {}),
      dev: Array.isArray(dev) ? dev.filter((item): item is string => typeof item === "string") : [],
    };
  } catch { return { state: "EMPTY" }; }
}

/**
 * Whether the committed contract's kill switch is on, read as the product reads it (`isKillSwitchActive` in src/apply/contract.ts,
 * not imported): the file at `killSwitchPath` (relative to the repository root) exists, or its state cannot be determined. A
 * contract with no readable `killSwitchPath` counts as on. Reads with `lstat` only.
 */
export function killSwitchOn(root: string): boolean {
  let path: unknown;
  try { path = (JSON.parse(readFileSync(join(root, CONTRACT_PATH), "utf8")) as { killSwitchPath?: unknown }).killSwitchPath; } catch { return true; }
  if (typeof path !== "string" || path === "" || path.includes("\u0000")) return true;
  try {
    lstatSync(resolve(root, path));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ENOENT";
  }
}

/** Whether the committed contract says enabled and carries a non-empty `authorize` (shape only). */
export function authorizationState(root: string): "EMPTY" | "PRESENT" {
  return contractScope(root).state;
}

/**
 * Whether the committed contract enables this path for this operation in DEV: enabled, `authorize.DEV` lists the operation,
 * and the contract names the path's provider and engine. A refusal names what is missing; the full check is still the children's.
 */
export function contractEnablesPath(scope: ContractScope, path: ActPathId, operation: "APPLY" | "CLEANUP"): { ok: true } | { ok: false; code: string; detail: string } {
  if (scope.state === "EMPTY") return { ok: false, code: "ACT_DISABLED", detail: "No committed contract authorizes ACT (enabled with a non-empty authorize): ACT is disabled. The owner's reviewed commit of the contract is the only switch." };
  const spec = ACT_PATH_SPEC[path];
  if (scope.provider !== spec.provider || scope.engine !== spec.engine) {
    return { ok: false, code: "CONTRACT_NOT_FOR_PATH", detail: "The committed contract names " + String(scope.provider ?? "no provider") + " " + String(scope.engine ?? "no engine") + ", not " + spec.provider + " " + spec.engine + ". Check out the commit that carries this path's contract." };
  }
  if (!scope.dev.includes(operation)) return { ok: false, code: "ACT_NOT_AUTHORIZED", detail: "The committed contract's authorize.DEV does not list " + operation + "." };
  return { ok: true };
}

/** An input only the owner can supply (delegated decision 3), with the reason the runner prints while it is missing. */
export type OwnerInput = { id: string; status: "BLOCKED" | "INFO"; code: string; detail: string };

export function ownerInputs(config: EvidenceRunnerConfig, authorization: "EMPTY" | "PRESENT"): OwnerInput[] {
  const inputs: OwnerInput[] = [];
  if (config.aws) {
    inputs.push({ id: "aws-noop-stack", status: "BLOCKED", code: "OWNER_INPUT_NOOP_STACK",
      detail: "Create the stack " + config.aws.qualificationStack + " in " + config.aws.expectedAccountId + "/" + config.aws.region +
        " by hand from qualification/provider/aws-noop-stack.yaml. The aws-readonly stage's producer previews a change set against it under the federated identity; the runner never creates, updates or deletes it." });
  }
  if (config.aws || config.azure || config.gcp) {
    inputs.push({ id: "federated-qualification-identity", status: "BLOCKED", code: "OWNER_INPUT_FEDERATED_IDENTITY",
      detail: "The read-only stages run ./alz qualify provider-aws|provider-azure under the federated DISCOVERY identity (ALZ_DISCOVERY_*, delivered by D4), never under your CLI login; a stage whose identity is not set is BLOCKED with the variables named." });
  }
  inputs.push(authorization === "EMPTY"
    ? { id: "pilot-authorization", status: "BLOCKED", code: "OWNER_INPUT_AUTHORIZATION",
      detail: "The act:* gates are produced after the owner's reviewed commit of the pilot contract with its authorize entry (docs/act-pilot-plan.md), one commit per path. ACT is disabled; the act and cleanup stages refuse." }
    : { id: "pilot-authorization", status: "INFO", code: "AUTHORIZATION_PRESENT",
      detail: "The committed contract says enabled and has an authorize entry (read for shape only). The guided stages run ./alz apply contract-check and preflight, which check it in full with the kill switch, before any other step." });
  if (!config.act) {
    inputs.push({ id: "act-targets", status: "BLOCKED", code: "OWNER_INPUT_ACT_TARGETS",
      detail: "The act and cleanup stages need the act block of the configuration: the repository the identity delivery runs in, and per path the project folder and the requester's id." });
  }
  return inputs;
}

export type PreflightInputs = {
  root: string;
  env: NodeJS.ProcessEnv;
  config: EvidenceRunnerConfig;
  source: SourceCommit;
  probe: IdentityProbe;
  /** The stages this run will start (the preflight is always one). Identities and the mutation rule follow from them. */
  stages: readonly StageId[];
  /** Files that differ between the candidate and HEAD, for a guided stage run at the commit that carries a path's contract. */
  changedPaths?: (from: string, to: string) => string[] | undefined;
};
export type Preflight = { checks: Check[]; identities: IdentityCheck[]; ownerInputs: OwnerInput[]; actScope: "EMPTY" | "PRESENT"; headCommit?: string; blocked: boolean };

/**
 * The source rule. Read-only stages and the summary run at the candidate itself. A guided stage runs at the commit that
 * carries its path's reviewed contract, which differs from the candidate in the contract file only (owner decision
 * 6483993252: each path's live apply runs at the commit holding that path's contract, and admission checks exactly this).
 */
function sourceCheck(input: PreflightInputs): Check {
  const { source, config, stages } = input;
  if (!source.ok) return { id: "source", status: "BLOCKED", code: "SOURCE_NOT_CLEAN", detail: source.reason };
  if (source.commit === config.candidateCommit) return { id: "source", status: "PASS", code: "CANDIDATE_IS_HEAD", detail: "Clean checkout of candidate " + source.commit.slice(0, 12) + "." };
  const guidedOnly = stages.filter((stage) => stage !== "preflight").length > 0 && stages.filter((stage) => stage !== "preflight").every(isGuidedStage);
  if (guidedOnly) {
    const changed = input.changedPaths?.(config.candidateCommit, source.commit);
    if (changed && changed.length === 1 && changed[0] === CONTRACT_PATH) {
      return { id: "source", status: "PASS", code: "CONTRACT_COMMIT_IS_HEAD",
        detail: "Clean checkout of " + source.commit.slice(0, 12) + ", which differs from candidate " + config.candidateCommit.slice(0, 12) + " in " + CONTRACT_PATH + " only (this path's contract commit)." };
    }
    return { id: "source", status: "BLOCKED", code: "CANDIDATE_NOT_HEAD",
      detail: "HEAD is " + source.commit.slice(0, 12) + "; a guided stage runs at the candidate " + config.candidateCommit.slice(0, 12) + " or at a commit that differs from it in " + CONTRACT_PATH + " only" +
        (changed ? " (this one also changes " + (changed.filter((path) => path !== CONTRACT_PATH).slice(0, 5).join(", ") || "nothing") + ")" : " (git could not compare them)") + "." };
  }
  return { id: "source", status: "BLOCKED", code: "CANDIDATE_NOT_HEAD",
    detail: "HEAD is " + source.commit.slice(0, 12) + " but the configuration names candidate " + config.candidateCommit.slice(0, 12) + "; check out the candidate." };
}

export async function runPreflight(input: PreflightInputs): Promise<Preflight> {
  const { root, env, config, probe, stages } = input;
  const checks: Check[] = [sourceCheck(input)];
  const readonly = stages.some((stage) => READONLY_STAGES.includes(stage));
  const mutation = mutationIdentityVariables(env);
  if (readonly) {
    checks.push(mutation.length > 0
      ? { id: "mutation-identities", status: "BLOCKED", code: "MUTATION_IDENTITY_PRESENT",
        detail: "Unset " + mutation.join(", ") + " first: read-only stages never run beside an identity that can write. Run act and cleanup stages on their own (--stage)." }
      : { id: "mutation-identities", status: "PASS", code: "NONE", detail: "No apply, state-write or change-set identity is set." });
  } else {
    checks.push({ id: "mutation-identities", status: "INFO", code: "NOT_CHECKED", detail: "No read-only stage is selected; the guided stages check the identities with ./alz apply identity-check and preflight." });
  }
  const scope = contractScope(root);
  checks.push({ id: "act", status: "INFO", code: scope.state === "EMPTY" ? "SKIPPED_ACT_DISABLED" : "AUTHORIZATION_PRESENT",
    detail: scope.state === "EMPTY" ? "No committed contract authorizes ACT: ACT is disabled and the act and cleanup stages refuse."
      : "The committed contract names " + String(scope.provider ?? "?") + " " + String(scope.engine ?? "?") + " and authorizes " + (scope.dev.join(", ") || "nothing") + " in DEV (shape only; the guided stages check it in full)." });
  const identities: IdentityCheck[] = [];
  for (const provider of PROVIDERS) {
    // A provider's identity is read only when its stage is selected and the configuration names it.
    if (!stages.includes(READONLY_STAGE_OF[provider])) continue;
    identities.push(compareIdentity(provider, config, targetOf(provider, config) ? await probe(provider, config) : { status: "PROBE_NOT_BUILT" }));
  }
  // A selected stage whose identity is missing or wrong refuses the whole run before anything is written or asked.
  const blocked = [...checks, ...identities].some((check) => check.status === "BLOCKED");
  return { checks, identities, ownerInputs: ownerInputs(config, scope.state), actScope: scope.state, ...(input.source.ok ? { headCommit: input.source.commit } : {}), blocked };
}
