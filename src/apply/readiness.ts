import { existsSync, lstatSync, readFileSync } from "node:fs";

import { engineActivation } from "../teardown/driver/qualification.js";
import type { EngineAdapter } from "../teardown/driver/types.js";
import { approvedToolDirs, resolveExecutable } from "../tools/child-env.js";
import { ENVIRONMENTS } from "./constants.js";
import {
  inspectPilotContract, isKillSwitchActive, loadPilotContract, loadQualificationRecords, repoPaths, verifyApplyQualification,
} from "./contract.js";
import { engineOf } from "./engine-spec.js";
import { attestedClientId, checkApplyIdentities, verifyIdentityTargets } from "./identities.js";
import type { PrepareBlocker } from "./prepare.js";
import { specOf } from "./provider.js";
import type { ApplyEnvironment, PilotContract } from "./types.js";

/**
 * Readiness: the one definition of what must be in place before a pilot seal, for `./alz apply preflight` and the console's
 * readiness step (docs/act-pilot-apply.md). Read-only and offline: it reads the contract, the pin, identity variables, the
 * approved tool folders, the kill switch and the encrypted qualification records. It calls no cloud, starts no engine,
 * prints names never values, and grants nothing: a READY report is information, and seal and apply run their own gates.
 */

/** Why an item is, or is not, ready. BLOCKED: a stop someone put in place on purpose (the kill switch). */
export type ReadinessState = "READY" | "MISSING" | "INVALID" | "UNVERIFIED" | "UNAVAILABLE" | "BLOCKED";
/** Who can make an item ready: the same parties preparation names. */
export type ReadinessItem = { check: string; ok: boolean; state: ReadinessState; responsible?: PrepareBlocker; detail?: string };
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
  contractPinPath?: string;
  qualificationDir?: string;
  toolDirs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
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
export async function qualificationReadiness(contract: PilotContract, input: Omit<ReadinessInput, "contractPath" | "contractPinPath">): Promise<QualificationReadiness> {
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
  const pinned = loadPilotContract(path, input.contractPinPath);
  add("pilot contract pinned and enabled (required before seal)", !("reason" in pinned) ? "READY" : pinned.code === "CONTRACT_INVALID" ? "INVALID" : "MISSING",
    "OWNER", "reason" in pinned ? pinned.reason : undefined);
  const identities = checkApplyIdentities(env, spec, engine.identities);
  add("identities configured, distinct, no fallback (" + engine.identities.join(", ") + ")",
    identities.ok ? "READY" : identities.code === "IDENTITY_NOT_CONFIGURED" ? "MISSING" : "INVALID", "OPERATOR", identities.ok ? undefined : identities.message);
  const targets = verifyIdentityTargets(contract, environment, env, spec, engine.identities);
  add("identities aimed at the " + environment + " account", targets.ok ? "READY" : "INVALID", "OPERATOR", targets.ok ? undefined : targets.message);
  // Informational, Terraform only (the one engine with a STATE_WRITE identity and a state backend): where the contract opts in,
  // sealing itself carries STATE_WRITE's non-secret settings (typed confirmation at seal). The CDK engine has no such item.
  if (engine.id === "TERRAFORM") add("plan will embed STATE_WRITE settings: " + (contract.embedStateWrite === true ? "yes" : "no"), "READY", "OWNER");
  for (const tool of engine.executables) {
    add("tool " + tool + " installed in an approved directory", resolveExecutable(tool, input.toolDirs ?? approvedToolDirs(env)) !== undefined ? "READY" : "UNAVAILABLE", "TOOL");
  }
  add("kill switch absent", isKillSwitchActive(contract) ? "BLOCKED" : "READY", "OWNER", contract.killSwitchPath);
  // The same records and checks seal and apply use: without them seal refuses ENGINE_NOT_QUALIFIED, so readiness does not say ready.
  const qualification = await qualificationReadiness(contract, { environment, qualificationDir: input.qualificationDir, toolDirs: input.toolDirs, env, now: input.now });
  add("engine qualified in DEV for seal and apply (" + engine.id + ")", qualification.state, "OWNER", qualification.detail);
  add("identity separation attested on the real DEV backend", qualification.state === "READY" ? "READY" : "UNVERIFIED", "OWNER", qualification.state === "READY"
    ? "Attested by the person who ran ./alz apply qualify, from the cloud's own logs; recorded in the qualification evidence."
    : "Not proven on a real backend until ./alz apply qualify has run against the real DEV target and its evidence matches this machine.");
  return report();
}
