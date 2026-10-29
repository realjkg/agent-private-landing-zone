import { ACT_RELEASE_PATHS, actGateId } from "../qualification/release-admission.js";
import { checkJourneyMatrix, JOURNEY_STEPS, loadJourneyMatrix, ROW_PROOFS, type StepStatus } from "./acceptance.js";
import { loadReleaseStatus } from "./status.js";

/**
 * The deployment paths the console lists (GET /pilot/paths, src/cli/ui-channel.ts): one entry per row of the journey matrix
 * (config/acceptance/journeys.json, checked by `checkJourneyMatrix`) with its `act:*` release gate (config/release/status.json).
 *
 * Read-only and information only. It reads the two records the release view reads, the way it reads them; it writes nothing,
 * starts nothing and grants nothing. Readiness of the contract's own path comes only from the readiness check the console already
 * ran (`preflight`), passed in by the caller, and only while the contract as it is NOW (read again by the caller on every request)
 * still matches it: same hash, APPLY still authorized for that environment, kill switch off. This module never assesses, guesses
 * or defaults readiness, and a path or an environment with missing, stale or unreadable data is never reported ready.
 */

export type PathEnvironment = "DEV" | "QA" | "PROD";
const ENVIRONMENT_ORDER: readonly PathEnvironment[] = ["DEV", "QA", "PROD"];

/**
 * Who or what a blocker waits on. OWNER and OPERATOR are people supplying inputs; SEQUENCED is another path's owner-run live step
 * that the record says must come first; UNKNOWN is a record that cannot be read; the rest is engineering, qualification or scope.
 */
export type PathParty = "OWNER" | "OPERATOR" | "SEQUENCED" | "ENGINEERING" | "QUALIFICATION" | "RELEASE_SCOPE" | "UNKNOWN";
export type PathBlocker = { party: PathParty; source: "SCOPE" | "JOURNEY" | "GATE"; text: string };

/** What one readiness check (`./alz apply preflight`) returned, as the console's channel remembers it. */
export type RememberedReadiness = {
  environment: PathEnvironment;
  ready: boolean;
  checks: { check: string; ok: boolean; responsible?: string }[];
  decisions: {
    act: "DISABLED" | "PILOT_ENABLED";
    contract: { code?: string; reason?: string; contractSha256?: string; provider?: string; engine?: string; killSwitch?: boolean };
    authorized: { environment: PathEnvironment; operations: string[] }[];
    approved: { environment: PathEnvironment; requiredApprovals: number }[];
  };
  checkedAt: string;
};

/**
 * The contract as it is when the paths are served: what `actDecisions` (src/apply/readiness.ts) reports without an environment,
 * derived read-only by the console's channel (src/cli/ui-channel.ts) on every request.
 */
export type CurrentContract =
  | { act: "DISABLED"; reason: string }
  | { act: "PILOT_ENABLED"; contractSha256: string; provider: string; engine: string; killSwitch: boolean;
      authorized: { environment: PathEnvironment; operations: string[] }[]; approved: { environment: PathEnvironment; requiredApprovals: number }[] };

/** The three decisions for one environment of the contract's path. `ready` is null when no readiness check has run for it. */
export type EnvironmentDecision = {
  environment: PathEnvironment;
  authorized: boolean;
  operations: string[];
  ready: boolean | null;
  /** The readiness items that did not pass, by name and who can fix each one. Empty when ready or not checked. */
  notReady: { check: string; responsible?: string }[];
  approved: boolean;
  requiredApprovals: number;
  checkedAt: string | null;
};

export type ContractView =
  | { state: "UNKNOWN" }
  | { state: "DISABLED"; reason: string }
  | { state: "ENABLED"; provider: string; engine: string; contractSha256: string; killSwitch: boolean };

export type DeploymentPath = {
  cloud: string;
  engine: string;
  label: string;
  inRelease: boolean;
  /** The journey row's live claim: NOT_IMPLEMENTED, BLOCKED or LIVE_PASS. */
  liveStatus: string;
  /** The row's weakest step. SYNTHETIC_PASS is proof with stand-ins only, never live. */
  journeyStatus: StepStatus;
  /** Every step and row proof passes (synthetically or live) and the row checks against this installation. */
  implemented: boolean;
  actGate: { id: string; status: string; owner: string; nextAction: string } | null;
  /** Why the path is not ready, the most fundamental first. */
  blockers: PathBlocker[];
  isContractPath: boolean;
  /** For the contract's path only: the per-environment decisions. */
  decisions?: EnvironmentDecision[];
};

export type PathsReport = {
  /** These are release records and a remembered readiness check, never live provider evidence. */
  label: "RELEASE_RECORDS";
  contract: ContractView;
  /** Per environment, what the contract enables; empty while the contract is UNKNOWN. `approved` means an approval quorum is configured, never that a change was approved. */
  environments: EnvironmentDecision[];
  paths: DeploymentPath[];
};

const CLOUD_WORDS: Readonly<Record<string, string>> = { AWS: "AWS", AZURE: "Azure", GCP: "GCP" };
const ENGINE_WORDS: Readonly<Record<string, string>> = { TERRAFORM: "Terraform", CDK: "CDK", BICEP: "Bicep", GCP_API: "API-native" };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const words = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const PASSING = new Set(["SYNTHETIC_PASS", "LIVE_PASS"]);

/**
 * The contract view from the contract as it is now, and the remembered readiness results that still describe it. A result is
 * dropped when the contract's hash changed, the kill switch is on, or APPLY is no longer authorized for its environment; a
 * missing, disabled or unreadable contract keeps none. Without a current contract (none given) the view is UNKNOWN.
 */
function contractOf(now: CurrentContract | undefined, remembered: readonly RememberedReadiness[]): { view: ContractView; current: RememberedReadiness[] } {
  if (now === undefined) return { view: { state: "UNKNOWN" }, current: [] };
  if (now.act !== "PILOT_ENABLED") return { view: { state: "DISABLED", reason: words(now.reason) || "The owner's reviewed rules are not in place." }, current: [] };
  const applies = (environment: PathEnvironment) => now.authorized.some((a) => a.environment === environment && a.operations.includes("APPLY"));
  const current = now.killSwitch ? [] : remembered.filter((r) => r.decisions.act === "PILOT_ENABLED" && r.decisions.contract.contractSha256 === now.contractSha256 &&
    r.decisions.contract.killSwitch !== true && applies(r.environment));
  return { view: { state: "ENABLED", provider: now.provider, engine: now.engine, contractSha256: now.contractSha256, killSwitch: now.killSwitch }, current };
}

function environmentsOf(now: CurrentContract | undefined, current: readonly RememberedReadiness[]): EnvironmentDecision[] {
  if (now === undefined) return [];
  return ENVIRONMENT_ORDER.map((environment) => {
    const entry = now.act === "PILOT_ENABLED" ? now.authorized.find((x) => x.environment === environment && x.operations.includes("APPLY")) : undefined;
    const quorum = now.act === "PILOT_ENABLED" ? now.approved.find((x) => x.environment === environment) : undefined;
    const checked = current.find((r) => r.environment === environment);
    const requiredApprovals = typeof quorum?.requiredApprovals === "number" ? quorum.requiredApprovals : 0;
    return {
      environment,
      authorized: entry !== undefined,
      operations: entry ? [...entry.operations] : [],
      ready: checked ? checked.ready === true : null,
      notReady: checked && checked.ready !== true ? checked.checks.filter((c) => c.ok !== true).map((c) => ({ check: c.check, ...(c.responsible ? { responsible: c.responsible } : {}) })) : [],
      approved: entry !== undefined && requiredApprovals >= 1,
      requiredApprovals,
      checkedAt: checked?.checkedAt ?? null,
    };
  });
}

/**
 * Whose step a row's live blocker is, from the record's own text: a named path that must go live first is SEQUENCED; a text
 * that names the owner is OWNER; anything else stays with engineering.
 */
export function livePartyOf(text: string): PathParty {
  if (/\b(?:goes|go|must pass|passes) live first\b/i.test(text)) return "SEQUENCED";
  if (/\bowner\b/i.test(text)) return "OWNER";
  return "ENGINEERING";
}

const GATE_PARTY: Readonly<Record<string, PathParty>> = { OWNER: "OWNER", ENGINEERING: "ENGINEERING" };

/** Every deployment path, from the records at `root` and the readiness checks the console remembers. */
export function deploymentPaths(root: string, remembered: readonly RememberedReadiness[], now?: CurrentContract): PathsReport {
  const matrix = loadJourneyMatrix(root);
  const checked = checkJourneyMatrix(matrix, root);
  const rows = isRecord(matrix) && Array.isArray(matrix.rows) ? matrix.rows : [];
  let gates: unknown[] | undefined;
  try {
    const status = loadReleaseStatus(root);
    gates = isRecord(status) && Array.isArray(status.gates) ? status.gates : undefined;
  } catch { gates = undefined; }
  const { view, current } = contractOf(now, remembered);
  const environments = environmentsOf(now, current);

  const paths = checked.rows.map((report): DeploymentPath => {
    const raw = rows.find((row) => isRecord(row) && row.cloud === report.cloud && row.path === report.path) as Record<string, unknown> | undefined;
    const name = report.cloud + "/" + report.path;
    const problems = checked.problems.filter((p) => p.startsWith(name + " "));
    const implemented = report.implemented && problems.length === 0;
    const released = ACT_RELEASE_PATHS.some((p) => p.provider === report.cloud && p.engine === report.path);
    const gateId = actGateId({ provider: report.cloud, engine: report.path });
    const entry = gates?.find((g) => isRecord(g) && g.gate === gateId);
    const actGate = isRecord(entry) && typeof entry.status === "string"
      ? { id: gateId, status: entry.status, owner: words(entry.owner), nextAction: words(entry.nextAction) }
      : null;
    // Without a readable status entry the release scope is unknown, not out of scope: the path stays listed as in this release
    // (it is one of the code's release paths) with an UNKNOWN blocker, so it is never ready and never called out of scope.
    const inRelease = released && actGate?.status !== "OUT_OF_SCOPE";

    const blockers: PathBlocker[] = [];
    const add = (blocker: PathBlocker) => { if (blocker.text !== "" && !blockers.some((b) => b.text === blocker.text)) blockers.push(blocker); };
    if (!released) add({ party: "RELEASE_SCOPE", source: "SCOPE", text: "Not in this release: it is not one of the release's ACT paths." });
    else if (actGate?.status === "OUT_OF_SCOPE") add({ party: "RELEASE_SCOPE", source: "SCOPE", text: "Not in this release: the owner's release scope excludes it." });
    if (problems.length > 0) {
      add({ party: "ENGINEERING", source: "JOURNEY", text: "The journey record for this path does not check against this installation (" + problems.length + " problem" + (problems.length === 1 ? "" : "s") + "), so nothing about it is counted as done." });
    }
    const steps = isRecord(raw?.steps) ? raw.steps : {};
    for (const step of JOURNEY_STEPS) {
      const claim = steps[step];
      if (PASSING.has(report.steps[step])) continue;
      add({ party: "ENGINEERING", source: "JOURNEY", text: isRecord(claim) ? words(claim.missing) || words(claim.blockedBy) : "" });
    }
    const proofs = isRecord(raw?.proofs) ? raw.proofs : {};
    for (const proof of ROW_PROOFS) {
      const claim = proofs[proof];
      if (isRecord(claim) && claim.status === "SYNTHETIC_PASS") continue;
      add({ party: "ENGINEERING", source: "JOURNEY", text: isRecord(claim) ? words(claim.missing) : "" });
    }
    const live = isRecord(raw?.live) ? raw.live : {};
    if (report.live !== "LIVE_PASS") {
      const text = words(live.blockedBy) || words(live.missing);
      add({ party: report.live === "BLOCKED" ? livePartyOf(text) : "ENGINEERING", source: "JOURNEY", text });
    }
    if (released && actGate === null) {
      add({ party: "UNKNOWN", source: "GATE", text: gates === undefined
        ? "Readiness unknown: the release status record cannot be read."
        : "Readiness unknown: the release status record has no readable entry for " + gateId + "." });
    }
    if (inRelease && actGate !== null && actGate.status !== "PASS") {
      add({ party: GATE_PARTY[actGate.owner] ?? "QUALIFICATION", source: "GATE", text: actGate.nextAction || "The " + gateId + " gate is " + actGate.status + "." });
    }
    const order: PathParty[] = ["RELEASE_SCOPE", "UNKNOWN", "ENGINEERING", "QUALIFICATION", "SEQUENCED", "OWNER", "OPERATOR"];
    blockers.sort((a, b) => order.indexOf(a.party) - order.indexOf(b.party));

    const isContractPath = view.state === "ENABLED" && view.provider === report.cloud && view.engine === report.path;
    return {
      cloud: report.cloud, engine: report.path,
      label: (CLOUD_WORDS[report.cloud] ?? report.cloud) + " · " + (ENGINE_WORDS[report.path] ?? report.path),
      inRelease, liveStatus: report.live, journeyStatus: report.status, implemented, actGate, blockers, isContractPath,
      ...(isContractPath ? { decisions: environments } : {}),
    };
  });
  return { label: "RELEASE_RECORDS", contract: view, environments, paths };
}

/**
 * The readiness check's own output (`preflight` stdout: the report with its `decisions`), if it has that shape. Anything else is
 * not remembered, so the paths view says "not checked" rather than reading a malformed result as ready.
 */
export function rememberedReadiness(data: unknown, checkedAt: string): RememberedReadiness | undefined {
  if (!isRecord(data) || !ENVIRONMENT_ORDER.includes(data.environment as PathEnvironment) || typeof data.ready !== "boolean" || !Array.isArray(data.checks)) return undefined;
  const decisions = data.decisions;
  if (!isRecord(decisions) || (decisions.act !== "DISABLED" && decisions.act !== "PILOT_ENABLED") || !isRecord(decisions.contract) ||
      !Array.isArray(decisions.authorized) || !Array.isArray(decisions.approved)) return undefined;
  const checks = data.checks.filter(isRecord).map((c) => ({ check: words(c.check), ok: c.ok === true, ...(typeof c.responsible === "string" ? { responsible: c.responsible } : {}) }));
  if (checks.length !== data.checks.length) return undefined;
  const contract = decisions.contract;
  const text = (key: string) => typeof contract[key] === "string" ? { [key]: contract[key] as string } : {};
  return {
    environment: data.environment as PathEnvironment, ready: data.ready, checks,
    decisions: {
      act: decisions.act,
      contract: { ...text("code"), ...text("reason"), ...text("contractSha256"), ...text("provider"), ...text("engine"), ...(contract.killSwitch === true ? { killSwitch: true } : {}) },
      authorized: decisions.authorized.filter((x): x is Record<string, unknown> => isRecord(x) && ENVIRONMENT_ORDER.includes(x.environment as PathEnvironment) && Array.isArray(x.operations))
        .map((x) => ({ environment: x.environment as PathEnvironment, operations: (x.operations as unknown[]).filter((o): o is string => typeof o === "string") })),
      approved: decisions.approved.filter((x): x is Record<string, unknown> => isRecord(x) && ENVIRONMENT_ORDER.includes(x.environment as PathEnvironment) && typeof x.requiredApprovals === "number")
        .map((x) => ({ environment: x.environment as PathEnvironment, requiredApprovals: x.requiredApprovals as number })),
    },
    checkedAt,
  };
}
