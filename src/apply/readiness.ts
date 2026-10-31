import { existsSync, lstatSync, readFileSync } from "node:fs";

import { engineActivation } from "../teardown/driver/qualification.js";
import type { EngineAdapter } from "../teardown/driver/types.js";
import { approvedToolDirs, resolveExecutable } from "../tools/child-env.js";
import { ENVIRONMENTS } from "./constants.js";
import {
  authorizationEntryOf, authorizationSha256Of, authorizeContract, inspectPilotContract, isKillSwitchActive, loadPilotContract, loadQualificationRecords, pilotContractSha256, repoPaths,
  verifyApplyQualification,
} from "./contract.js";
import { engineOf } from "./engine-spec.js";
import { attestedClientId, checkApplyIdentities, verifyIdentityTargets } from "./identities.js";
import { checkDeliveredTokens, deliveryPathOf } from "./token-delivery.js";
import type { PrepareBlocker } from "./prepare.js";
import { specOf } from "./provider.js";
import { costPaths, readCostSnapshot, type CostSnapshot } from "../cost/local.js";
import type { ActOperation, ApplyEnvironment, PilotContract } from "./types.js";

/**
 * Readiness: the one definition of what must be in place before a pilot seal, for `./alz apply preflight` and the console's
 * readiness step (docs/act-pilot-apply.md). Read-only and offline: it reads the contract, identity variables, the
 * approved tool folders, the kill switch and the encrypted qualification records. It calls no cloud, starts no engine,
 * prints names never values, and grants nothing: a READY report is information, and seal and apply run their own gates.
 */

/** Why an item is, or is not, ready. BLOCKED: a stop someone put in place on purpose (the kill switch). */
export type ReadinessState = "READY" | "MISSING" | "INVALID" | "UNVERIFIED" | "UNAVAILABLE" | "BLOCKED";
/** Who can make an item ready: the same parties preparation names. */
/** `advisory`: reported for the person, never a stop (the financial controls item); `ok` stays true. */
export type ReadinessItem = { check: string; ok: boolean; state: ReadinessState; responsible?: PrepareBlocker; detail?: string; advisory?: true };
export type ReadinessReport = {
  environment: ApplyEnvironment;
  ready: boolean;
  checks: ReadinessItem[];
  /** The first item that is not ready, in the order the journey needs them, or none. Never a step past it. */
  next: { check: string; responsible: PrepareBlocker } | null;
};
export type ReadinessInput = {
  environment: ApplyEnvironment;
  contractPath?: string;
  qualificationDir?: string;
  toolDirs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** The saved cost status (src/cost/local.ts). Default: .runs/cost/status.json under the repository. */
  costStatusPath?: string;
};

const MAX_CONTRACT_BYTES = 8 * 1024 * 1024;

/** What readiness can say about qualification, from the same records and checks seal and apply use. */
export type QualificationReadiness =
  | { state: "READY"; engineVersion: string; qualifiedAt: string; detail: string }
  | { state: "MISSING" | "INVALID"; detail: string };

/**
 * Whether the contract's engine is qualified for both its preview (seal) and apply adapters, and whether the apply
 * qualification still matches this machine (engine binary, attested principals, DEV target, age). The same
 * `engineActivation` and `verifyApplyQualification` the driver runs, so readiness cannot say "ready" where seal or apply
 * refuse. Without a usable record the answer is MISSING (run `./alz apply qualify` in DEV); one that no longer matches is INVALID.
 */
export async function qualificationReadiness(contract: PilotContract, input: Omit<ReadinessInput, "contractPath">): Promise<QualificationReadiness> {
  const engine = engineOf(contract);
  const spec = specOf(contract);
  const vault = input.qualificationDir ?? repoPaths().qualifications;
  let records: Awaited<ReturnType<typeof loadQualificationRecords>>;
  try { records = await loadQualificationRecords(spec, vault); } catch { return { state: "INVALID", detail: "The qualification records cannot be read with this evidence key." }; }
  const preview = engine.previewAdapter();
  const latest = records.filter((r) => r.engine === engine.id && r.adapterVersion === preview.adapterVersion && r.argvDigest === preview.argvDigest)
    .sort((a, b) => b.qualifiedAt.localeCompare(a.qualifiedAt))[0];
  if (!latest) return { state: "MISSING", detail: "No qualification record exists for this engine's preview adapter. A person runs ./alz apply qualify against DEV." };
  // Seal needs the preview adapter's record and apply the apply adapter's, both for the same engine version.
  const [previewRecord, applyRecord] = [preview, engine.applyAdapter].map((adapter) =>
    engineActivation(engine.id, records, [adapter as unknown as EngineAdapter], latest.engineVersion));
  if (!previewRecord.enabled) return { state: "MISSING", detail: previewRecord.reason };
  if (!applyRecord.enabled) return { state: "MISSING", detail: applyRecord.reason };
  const env = input.env ?? process.env;
  const attested = await verifyApplyQualification(applyRecord.record, vault,
    { adapterVersion: engine.applyAdapter.adapterVersion, argvDigest: engine.applyAdapter.argvDigest, engineVersion: latest.engineVersion },
    {
      dev: contract.targets.DEV, now: (input.now ?? (() => new Date()))(), terraformSha256: engine.binarySha256(input.toolDirs, env),
      stateWriteClientId: attestedClientId(env, engine.attests[0], spec), applyClientId: attestedClientId(env, engine.attests[1], spec),
      principalsPerEnvironment: spec.principalPerEnvironment && input.environment !== "DEV",
    }, spec);
  if (!attested.ok) return { state: "INVALID", detail: attested.message };
  return { state: "READY", engineVersion: latest.engineVersion, qualifiedAt: latest.qualifiedAt,
    detail: "Qualified in DEV for engine version " + latest.engineVersion + " on " + latest.qualifiedAt.slice(0, 10) + "; the evidence matches this machine." };
}

/** The financial controls item. Its name starts "financial controls" (the console's words key on it). */
export const FINANCIAL_CHECK = "financial controls (budget, alerts and cost visibility; advisory)";
/** A saved status older than this is not used: readiness asks for a new read rather than report an old one as current. */
export const COST_STATUS_MAX_AGE_HOURS = 24;

/**
 * The advisory financial controls state from the saved cost status. A budget tracks spend and alerts; it never caps it, so
 * READY means "the budget, its alerts, tags and export were read and look right", never "spend is limited". Never a stop.
 * - nothing read, unreadable, another account, or too old: UNVERIFIED (nothing current was read);
 * - OBSERVED_COMPLETE: READY; WAITING (deployed, AWS has no spend or export delivery yet): UNVERIFIED, never zero spend;
 * - STALE (the export stopped delivering) and INCOMPLETE (a read was denied or not answered): UNAVAILABLE;
 * - ATTENTION: MISSING when the budget is not there, otherwise INVALID, with what needs attention.
 */
export function costReadiness(snapshot: CostSnapshot, contract: PilotContract, environment: ApplyEnvironment, now: Date): { state: ReadinessState; detail: string } {
  const run = "Run ./alz cost status in a terminal (read-only) to read the budget, alerts, tags and cost export again.";
  if (contract.provider !== "AWS") return { state: "UNVERIFIED", detail: "The cost status reads AWS only; this contract's provider is " + contract.provider + ". The owner confirms the budget and its alerts out of band." };
  if (snapshot.state === "NONE") return { state: "UNVERIFIED", detail: "No cost status has been read on this computer. " + run };
  if (snapshot.state === "UNREADABLE") return { state: "UNVERIFIED", detail: "The saved cost status cannot be read as a cost status. " + run };
  const status = snapshot.status;
  const target = contract.targets[environment] as { accountId?: unknown } | undefined;
  if (target?.accountId !== status.accountId) return { state: "UNVERIFIED", detail: "The saved cost status was read from a different account than this environment's target. " + run };
  const age = now.getTime() - Date.parse(status.capturedAt);
  if (age > COST_STATUS_MAX_AGE_HOURS * 3_600_000 || age < -5 * 60_000) {
    return { state: "UNVERIFIED", detail: "The saved cost status was read " + status.capturedAt.slice(0, 16) + "Z, not within the last " + COST_STATUS_MAX_AGE_HOURS + " hours. " + run };
  }
  const at = " (read " + status.capturedAt.slice(0, 16) + "Z).";
  switch (status.overall) {
    case "OBSERVED_COMPLETE":
      return { state: "READY", detail: "The budget, its alerts, the required tags, the cost-allocation tags and the cost export were read from AWS" + at + " A budget alerts; it never caps spend." };
    case "WAITING":
      return { state: "UNVERIFIED", detail: "Deployed, and AWS has not reported spend or the first cost export delivery yet" + at + " No data yet is not zero spend." };
    case "STALE":
      return { state: "UNAVAILABLE", detail: "The cost export has not delivered within " + status.freshness.staleAfterHours + " hours, so current cost data is not available" + at };
    case "INCOMPLETE":
      return { state: "UNAVAILABLE", detail: "Some cost reads did not answer (for example a denied read), so those values are UNKNOWN, not passing" + at };
    case "ATTENTION": {
      const b = status.budget;
      const needs = [
        b.state === "MISSING" ? "the budget was not found" : "",
        b.hasActualAlert.label === "OBSERVED" && !b.hasActualAlert.value ? "the budget has no actual-spend alert" : "",
        b.notifications.label === "OBSERVED" && b.notifications.value.some((n) => n.subscribers.label === "OBSERVED" && n.subscribers.value.length === 0) ? "an alert has no recipient" : "",
        status.tags.state === "MISSING" ? "resources are missing required tags" : status.tags.state === "NO_RESOURCES_FOUND" ? "no tagged resources were found" : "",
        status.costAllocationTags.state === "INACTIVE" ? "cost-allocation tags are inactive" : "",
        status.export.state === "MISSING" ? "the cost export was not found" : status.export.state === "FAILED" ? "the cost export failed" : "",
        status.export.configValid.label === "OBSERVED" && !status.export.configValid.value ? "the cost export's configuration is not the intended one" : "",
      ].filter(Boolean);
      return { state: b.state === "MISSING" ? "MISSING" : "INVALID", detail: "Needs attention: " + (needs.join("; ") || "see the cost status") + at };
    }
  }
}

/** Every readiness item for the environment, in the order the journey needs them. */
export async function assessReadiness(input: ReadinessInput): Promise<ReadinessReport> {
  if (!(ENVIRONMENTS as readonly string[]).includes(input.environment)) throw new Error("READINESS_ENVIRONMENT_INVALID");
  const { environment } = input;
  const checks: ReadinessItem[] = [];
  const add = (check: string, state: ReadinessState, responsible: PrepareBlocker, detail?: string) => {
    checks.push({ check, ok: state === "READY", state, ...(state === "READY" ? {} : { responsible }), ...(detail === undefined ? {} : { detail }) });
  };
  const report = (): ReadinessReport => {
    const first = checks.find((c) => !c.ok);
    return { environment, ready: first === undefined, checks, next: first ? { check: first.check, responsible: first.responsible! } : null };
  };

  // Missing owner configuration is a readiness item, not an error. Readiness never synthesizes or enables a contract.
  const path = input.contractPath ?? repoPaths().contract;
  let raw: unknown;
  try {
    if (lstatSync(path).size > MAX_CONTRACT_BYTES) throw new Error("too large");
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    const present = existsSync(path);
    add("contract shape (provider, engine, targets, approvals, approvers)", present ? "INVALID" : "MISSING", "OWNER", present
      ? "The pilot contract exists but cannot be read as valid JSON. Ask the pilot owner to correct it."
      : "The pilot contract has not been installed by the owner. Infrastructure ACT remains disabled.");
    return report();
  }
  const inspected = inspectPilotContract(raw);
  add("contract shape (provider, engine, targets, approvals, approvers)", inspected.ok ? "READY" : "INVALID", "OWNER", inspected.ok ? undefined : inspected.reason);
  if (!inspected.ok) return report();
  const { contract } = inspected;
  const spec = specOf(contract);
  const engine = engineOf(contract);
  const env = input.env ?? process.env;
  // AUTHORIZED is its own decision (`actDecisions`); readiness still stops on it, because seal refuses without it.
  const loaded = loadPilotContract(path);
  const authorized = "reason" in loaded ? undefined : authorizeContract(loaded, environment, "APPLY");
  add("pilot contract enabled and authorizes APPLY in " + environment + " (required before seal)",
    authorized?.ok ? "READY" : "reason" in loaded && loaded.code === "CONTRACT_INVALID" ? "INVALID" : "MISSING",
    "OWNER", "reason" in loaded ? loaded.reason : authorized && !authorized.ok ? authorized.message : undefined);
  const configured = checkApplyIdentities(env, spec, engine.identities);
  // Token files the identity delivery runner wrote are judged as seal and apply judge them (docs/act-pilot-identity-delivery.md).
  const deliveryPath = deliveryPathOf(spec.id, engine.id);
  const delivered = configured.ok && deliveryPath ? checkDeliveredTokens({ env, path: deliveryPath, now: (input.now ?? (() => new Date()))(), repoRoot: repoPaths().root }) : configured;
  const identities = delivered.ok ? configured : delivered;
  add("identities configured, distinct, no fallback (" + engine.identities.join(", ") + ")",
    identities.ok ? "READY" : identities.code === "IDENTITY_NOT_CONFIGURED" ? "MISSING" : "INVALID", "OPERATOR", identities.ok ? undefined : identities.message);
  const targets = verifyIdentityTargets(contract, environment, env, spec, engine.identities);
  add("identities aimed at the " + environment + " account", targets.ok ? "READY" : "INVALID", "OPERATOR", targets.ok ? undefined : targets.message);
  // Informational, Terraform only (the one engine with a STATE_WRITE identity and a state backend): the contract must bind STATE_WRITE
  // (owner decision 6486426552; a contract without it fails to load, so this row reads "yes"), and sealing carries STATE_WRITE's
  // non-secret settings (typed confirmation at seal). The CDK engine has no such item.
  if (engine.id === "TERRAFORM") add("plan will embed STATE_WRITE settings: " + (contract.embedStateWrite === true ? "yes" : "no"), "READY", "OWNER");
  for (const tool of engine.executables) {
    add("tool " + tool + " installed in an approved directory", resolveExecutable(tool, input.toolDirs ?? approvedToolDirs(env)) !== undefined ? "READY" : "UNAVAILABLE", "TOOL");
  }
  add("kill switch absent", isKillSwitchActive(contract) ? "BLOCKED" : "READY", "OWNER", contract.killSwitchPath);
  // The same records and checks seal and apply use: without them seal refuses ENGINE_NOT_QUALIFIED, so readiness does not say ready.
  const qualification = await qualificationReadiness(contract, { environment, qualificationDir: input.qualificationDir, toolDirs: input.toolDirs, env, now: input.now });
  add("engine qualified in DEV for seal and apply (" + engine.id + ")", qualification.state, "OWNER", qualification.detail);
  // Financial controls: advisory, never a stop (owner direction 6536926009). The state comes from the cost status the last
  // `./alz cost status` read from AWS and saved on this computer (src/cost/local.ts); readiness reads that file and calls no cloud.
  const cost = costReadiness(readCostSnapshot(input.costStatusPath ?? costPaths(repoPaths().root).status), contract, environment, (input.now ?? (() => new Date()))());
  checks.push({ check: FINANCIAL_CHECK, ok: true, state: cost.state, advisory: true, detail: cost.detail });
  add("identity separation attested on the real DEV backend", qualification.state === "READY" ? "READY" : "UNVERIFIED", "OWNER", qualification.state === "READY"
    ? "Attested by the person who ran ./alz apply qualify, from the cloud's own logs; recorded in the qualification evidence."
    : "Not proven on a real backend until ./alz apply qualify has run against the real DEV target and its evidence matches this machine.");
  return report();
}

/**
 * The one generated view of the three decisions (owner decisions, #39): AUTHORIZED (the contract's authorize entries and their
 * hashes), READY (the readiness items, when an environment is named) and APPROVED/EXECUTE (what each run still needs: the
 * requester's signature and the contract's approval quorum). `./alz apply status`, `./alz apply preflight` and the console's
 * pilot status block all read it. Read-only; it grants nothing.
 */
export type ActDecisions = {
  act: "DISABLED" | "PILOT_ENABLED";
  contract: { code?: string; reason?: string; contractSha256?: string; provider?: string; engine?: string; killSwitch?: boolean };
  /** Per environment, the authorized operations and the entry's hash. The account is bound by the hash and never printed (readiness names no value). */
  authorized: { environment: ApplyEnvironment; operations: ActOperation[]; authorizationSha256: string }[];
  ready: ReadinessReport | null;
  approved: { environment: ApplyEnvironment; requester: "SIGNS_AT_SEAL_OR_PROPOSAL"; requiredApprovals: number }[];
};

export async function actDecisions(input: Omit<ReadinessInput, "environment"> & { environment?: ApplyEnvironment }): Promise<ActDecisions> {
  const loaded = loadPilotContract(input.contractPath ?? repoPaths().contract);
  const ready = input.environment ? await assessReadiness({ ...input, environment: input.environment }) : null;
  if ("reason" in loaded) return { act: "DISABLED", contract: { code: loaded.code, reason: loaded.reason }, authorized: [], ready, approved: [] };
  const envs = ENVIRONMENTS.filter((e) => authorizationEntryOf(loaded, e) !== undefined);
  return {
    act: "PILOT_ENABLED",
    contract: { contractSha256: pilotContractSha256(loaded), provider: loaded.provider, engine: loaded.engine, killSwitch: isKillSwitchActive(loaded) },
    authorized: envs.map((e) => {
      const entry = authorizationEntryOf(loaded, e)!;
      return { environment: e, operations: entry.operations, authorizationSha256: authorizationSha256Of(entry) };
    }),
    ready,
    approved: envs.map((e) => ({ environment: e, requester: "SIGNS_AT_SEAL_OR_PROPOSAL" as const, requiredApprovals: loaded.requiredApprovals[e] ?? 0 })),
  };
}
