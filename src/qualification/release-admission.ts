import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { authorizeContract, loadPilotContract, parsePilotContract, pilotContractSha256 } from "../apply/contract.js";
import type { ApplyEnvironment, EngineId, PilotContract, ProviderId } from "../apply/types.js";
import { PREVIEW_GATE_SCENARIOS, previewGateEvidenceProblems, previewScenarioOf } from "./preview-gate.js";
import { recoveryGateEvidenceProblems } from "./recovery-gate.js";
export { PREVIEW_GATE_SCENARIOS, previewScenarioOf, type PreviewGateScenario } from "./preview-gate.js";
const previewScenarioIds = Object.keys(PREVIEW_GATE_SCENARIOS);
import { PRODUCTION_DEPLOYMENT_CONTRACT, pilotCombinationListed } from "./production-contract.js";

export type ReleaseGateMode =
  | "CI" | "PRIVATE_MODEL" | "LIVE_PROVIDER" | "LIVE_PREVIEW"
  | "ISOLATED_RECOVERY" | "LIFECYCLE" | "SECURITY_SCAN" | "LIVE_METRIC"
  | "LIVE_ACT" | "ACT_RECOVERY" | "INDEPENDENT_REVIEW";
export type ReleaseGate = {
  id: string;
  mode: ReleaseGateMode;
  why: string;
};
/** The operating systems a release is qualified on, one gate each: a Linux pass never stands in for macOS or Windows. */
export const RELEASE_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-arm64", "win32-x64"] as const;
/** What one platform's lifecycle report must show it actually ran on that host. */
export const PLATFORM_LIFECYCLE_CHECKS = [
  "install", "launch", "uninstall", "repeat-uninstall", "partial-install-recovery", "unusual-paths", "unrelated-files-preserved",
] as const;
/** The pilot paths a release can qualify live, each against its journey row (config/acceptance/journeys.json). */
export const ACT_RELEASE_PATHS: readonly { provider: ProviderId; engine: EngineId }[] = [
  { provider: "AWS", engine: "TERRAFORM" }, { provider: "AZURE", engine: "TERRAFORM" }, { provider: "AWS", engine: "CDK" },
  // Path 4, admitted in code for DEV only (owner decision E2, #39). Its gate is an unmet requirement (BLOCKED) until live evidence exists.
  { provider: "AZURE", engine: "BICEP" },
  // Path 5, admitted in code for DEV only (#339; owner decision 6481421924, #39). Its gate is BLOCKED until live evidence exists.
  // GCP API-native (path 6, act:gcp-gcp_api) is added by its own integration step once the engine is admitted, not here.
  { provider: "GCP", engine: "TERRAFORM" },
];
/** Which cloud each live-provider gate's report must name. A gate missing here admits no report (never a default cloud). */
const LIVE_PROVIDER_CLOUD: Readonly<Record<string, string>> = { "aws-provider": "AWS", "azure-provider": "AZURE", "gcp-provider": "GCP" };
export const actGateId = (path: { provider: string; engine: string }): string => "act:" + path.provider.toLowerCase() + "-" + path.engine.toLowerCase();
export const PRODUCTION_RELEASE_GATES: readonly ReleaseGate[] = [
  { id: "source-ci", mode: "CI", why: "Type check and functional regression on exact release source" },
  { id: "release-archive", mode: "CI", why: "Reproducible archive, SBOM, release manifest and provenance" },
  { id: "arm64-final-image", mode: "SECURITY_SCAN", why: "Actual ARM64 runtime image and blocking vulnerability scan" },
  { id: "private-model-runtime", mode: "PRIVATE_MODEL", why: "Target-host Qwen/Mistral models, digests, restart and long-session recovery" },
  { id: "aws-provider", mode: "LIVE_PROVIDER", why: "Live authenticated read-only AWS inventory and governed preview" },
  { id: "azure-provider", mode: "LIVE_PROVIDER", why: "Live authenticated read-only Azure inventory and governed preview" },
  { id: "gcp-provider", mode: "LIVE_PROVIDER", why: "Live authenticated read-only GCP inventory and governed preview" },
  ...previewScenarioIds.map((id) => ({
    id: "preview:" + id,
    mode: "LIVE_PREVIEW" as const,
    why: "Exact provider/IaC scenario with real tool output and no infrastructure mutation",
  })),
  { id: "isolated-recovery", mode: "ISOLATED_RECOVERY", why: "Actual isolated restore with measured recovery objectives" },
  ...["clean-install", "upgrade", "rollback", "uninstall", "configuration-migration"].map((id) => ({
    id: "lifecycle:" + id, mode: "LIFECYCLE" as const,
    why: "Actual lifecycle execution with data integrity and rollback evidence",
  })),
  ...RELEASE_PLATFORMS.map((id) => ({
    id: "platform:" + id, mode: "LIFECYCLE" as const,
    why: "Install, launch, uninstall and recovery on a real disposable " + id + " host",
  })),
  ...ACT_RELEASE_PATHS.map((path) => ({
    id: actGateId(path), mode: "LIVE_ACT" as const,
    why: "Owner-supervised DEV apply on the real account, recorded from its own ledger evidence (./alz apply record-live)",
  })),
  { id: "act-run-recovery", mode: "ACT_RECOVERY", why: "An interrupted real pilot apply reconciled from its ledger, never resumed without new approval" },
  { id: "security-review:independent", mode: "INDEPENDENT_REVIEW", why: "Security review of the candidate by someone who did not write it" },
  ...["operational-excellence", "security", "reliability", "performance", "cost", "sustainability"].map((id) => ({
    id: "pillar:" + id, mode: "LIVE_METRIC" as const,
    why: "Actual deployed-environment measurement, not a synthetic fixture",
  })),
];

export type ReleaseGateSubmission = {
  id: string;
  mode: ReleaseGateMode;
  sourceCommit: string;
  targetHardwareId: string;
  evidencePath: string;
  evidenceSha256: string;
};
export type ReleaseAdmissionInput = {
  schemaVersion: 1;
  sourceCommit: string;
  operatingMode: "PREVIEW_OPERATE";
  /** DISABLED, or PILOT for a release admitted under an enabled pilot contract (see `actPilot`). Nothing else. */
  infrastructureAct: "DISABLED" | "PILOT";
  /**
   * With PILOT, exactly one of `actPilot` or `actPilots`; forbidden otherwise. `actPilot` is the one pilot scope, bound by hash to the
   * contract the candidate itself carries (config/act-pilot-contract.json): a single-path release.
   */
  actPilot?: ActPilotScope;
  /**
   * A multi-path release (six-path DEV release, owner decision 6483993252 on #39): one entry per ACT path the candidate admits, each
   * bound to its own reviewed contract by hash and to the commit that carries that contract. The product reads one committed contract
   * per checkout, so each path's live apply runs at the commit that holds that path's contract; admission reads the contract from that
   * commit with the same loader and checks that its tree differs from the candidate's in the contract file only.
   */
  actPilots?: ActPilotPath[];
  records: ReleaseGateSubmission[];
};
export type ActPilotScope = { provider: ProviderId; engine: EngineId; contractSha256: string };
/** One path of a multi-path pilot release: its scope and the commit whose committed contract file is that scope's contract. */
export type ActPilotPath = ActPilotScope & { contractCommit: string };
/**
 * A path's contract as its commit holds it: the contract file's verdict from `parsePilotContract`, and the repository paths whose
 * content differs between that commit and the candidate. Anything that cannot be read is `ok: false`, never a guess.
 */
export type ContractAtCommit =
  | { ok: true; contract: PilotContract | { enabled: false }; changedPaths: string[] }
  | { ok: false; reason: string };
export type ContractReader = (commit: string) => Promise<ContractAtCommit>;
export type GateReview = {
  id: string;
  mode: ReleaseGateMode;
  /** OUT_OF_SCOPE only for a gate the owner's release scope excludes (config/release/scope.json). */
  status: "EVIDENCE_PRESENT" | "BLOCKED" | "OUT_OF_SCOPE";
  blockers: string[];
  evidenceSha256?: string;
};
export type ReleaseAdmissionReport = {
  sourceCommit: string;
  readyForIndependentReleaseReview: boolean;
  productionReleaseApproved: false;
  /** ACT is disabled globally. The pilot contract is its only exception, reported in `actPilot`. */
  infrastructureAct: "DISABLED";
  actPilot: ActPilotScope | null;
  /** The paths of a multi-path pilot release (`actPilots`), each verified against its own contract; empty otherwise. */
  actPilots: ActPilotPath[];
  gates: GateReview[];
  blockers: string[];
  candidateIdentityHash: string;
};

const sha40 = /^[0-9a-f]{40}$/;
const sha64 = /^[0-9a-f]{64}$/;
type Json = Record<string, unknown>;
function isObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function digest(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}
/**
 * What a PILOT release binds a live ACT or recovery record to, one entry per admitted path: the path's gate, its reviewed contract's
 * hash, the commit that carries that contract (the candidate itself for a single-path release), its required approvals per
 * environment, and the hash of its APPLY authorization per environment. A record is checked only against its own path's entry, never
 * against another path's contract. Null for a release with no pilot scope; empty for a PILOT release whose scope did not verify.
 */
type PathBinding = {
  gateId: string; contractSha256: string; contractCommit: string;
  requiredApprovals: PilotContract["requiredApprovals"]; applyAuthorizationSha256: Partial<Record<ApplyEnvironment, string>>;
};
type PilotBinding = PathBinding[] | null;

function observedLivePayload(value: unknown, gate: ReleaseGate, record: ReleaseGateSubmission, commit: string, pilot: PilotBinding): boolean {
  if (!isObject(value)) return false;
  if (value.mutationObserved === true ||
      value.mock === true || value.fixture === true ||
      value.simulation === true || value.mode === "OFFLINE_FIXTURE_ONLY" ||
      value.mode === "LIVE_LOCAL_MODELS_WITH_SYNTHETIC_AWS_EVIDENCE") return false;
  if (gate.mode === "PRIVATE_MODEL") {
    const production = value.production;
    const records = value.records;
    const stack = value.stackChecks;
    if (!isObject(production) || production.passed !== true ||
        !isObject(production.context) || !isObject(production.context.host) ||
        production.context.sourceCommit !== commit ||
        production.context.host.targetHardwareId !== record.targetHardwareId ||
        !isObject(production.session) ||
        production.session.mutationObserved !== false ||
        !Array.isArray(production.checks) || production.checks.length === 0 ||
        !production.checks.every((x) => isObject(x) && x.passed === true) ||
        !Array.isArray(records) || records.length < 3 ||
        !Array.isArray(stack) || stack.length === 0 ||
        !stack.every((x) => isObject(x) && x.passed === true)) return false;
    const models = new Set<string>();
    for (const x of records) {
      if (!isObject(x) || x.passed !== true ||
          typeof x.model !== "string" ||
          typeof x.digest !== "string" || !sha64.test(x.digest)) return false;
      models.add(x.model);
    }
    return value.passed === true &&
      ["qwen3:1.7b", "qwen3:4b", "mistral-nemo:12b"].every((m) => models.has(m));
  }
  if (gate.mode === "LIVE_PROVIDER") {
    if (value.sourceCommit !== commit || value.actEnabled !== false ||
        value.ready !== true || value.blockers === undefined ||
        !Array.isArray(value.blockers) || value.blockers.length !== 0 ||
        !isObject(value.discovery) || !isObject(value.validation) ||
        !isObject(value.preview)) return false;
    const provider = Object.hasOwn(LIVE_PROVIDER_CLOUD, gate.id) ? LIVE_PROVIDER_CLOUD[gate.id] : undefined;
    return provider !== undefined && value.provider === provider &&
      value.validation.passed === true &&
      typeof value.discovery.snapshotSha256 === "string" &&
      sha64.test(value.discovery.snapshotSha256) &&
      Array.isArray(value.discovery.evidenceSources) &&
      !value.discovery.evidenceSources.includes("mock") &&
      typeof value.preview.outputSha256 === "string" &&
      sha64.test(value.preview.outputSha256);
  }
  if (gate.mode === "LIVE_ACT") {
    // The live record `./alz apply record-live` writes from the apply's own ledger evidence (src/apply/live-record.ts).
    const path = ACT_RELEASE_PATHS.find((x) => actGateId(x) === gate.id);
    // Under a PILOT release the record must name the reviewed contract of its own path (#269 review N2), that contract's APPLY
    // authorization for the record's environment, and the commit that carries that contract: a record of an apply under another
    // contract, another path's contract included, is not this release's live evidence. A path the release does not bind admits none.
    const bound = pilot === null ? undefined : pilot.find((x) => x.gateId === gate.id);
    return path !== undefined && value.schemaVersion === 1 && value.label === "LIVE" && value.step === "execute" &&
      value.cloud === path.provider && value.engine === path.engine &&
      value.outcome === "SUCCEEDED" && typeof value.attestedBy === "string" && value.attestedBy.trim() !== "" &&
      [value.artifactSha256, value.evidenceSha256, value.contractSha256, value.authorizationSha256].every((x) => typeof x === "string" && sha64.test(x)) &&
      (pilot === null ? value.sourceCommit === commit : bound !== undefined && value.sourceCommit === bound.contractCommit &&
        value.contractSha256 === bound.contractSha256 &&
        value.authorizationSha256 === bound.applyAuthorizationSha256[value.environment as ApplyEnvironment]);
  }
  // These statements must be produced by real target/CI tools. The checker
  // validates provenance and content, not the honesty of an external machine.
  const report = value as Json;
  // A recovery report is bound, under a PILOT release, to the path whose contract it names: it ran at the commit carrying that contract.
  const recoveryBinding = gate.mode === "ACT_RECOVERY" && pilot !== null ? pilot.find((x) => x.contractSha256 === report.contractSha256) : undefined;
  if (gate.mode === "ACT_RECOVERY" && pilot !== null && recoveryBinding === undefined) return false;
  const reportCommit = recoveryBinding?.contractCommit ?? commit;
  // A recovery report is about a pilot apply, so it is the one report that may say ACT ran.
  if (report.sourceCommit !== reportCommit || (gate.mode !== "ACT_RECOVERY" && report.actEnabled !== false) ||
      report.targetHardwareId !== record.targetHardwareId ||
      report.schemaVersion !== 1 || report.gateId !== gate.id ||
      report.executionMode !== gate.mode || report.passed !== true ||
      report.targetHardwareId === "UNKNOWN" ||
      typeof report.targetHardwareId !== "string" ||
      !Array.isArray(report.checks) || report.checks.length === 0 ||
      !report.checks.every((x) => isObject(x) &&
        x.passed === true && typeof x.evidenceSha256 === "string" &&
        sha64.test(x.evidenceSha256))) return false;
  if (gate.mode === "LIVE_PREVIEW") {
    // The evidence is a valid preview-gate document of this gate and this commit (src/qualification/preview-gate.ts: the exact
    // scenario, provider, engine and estate; exactly the six live conditions, all true, with the label, mode, `passed`,
    // `simulation`, `reasons`, attestation and qualification derived from them), and it calls itself LIVE. A document that lacks
    // the conditions, has an empty or partial set, or was relabeled by hand with its conditions flipped and its reasons, null
    // attestation or UNQUALIFIED provenance left behind, is refused here, not only by the producer's own validator.
    if (previewGateEvidenceProblems(report, { sourceCommit: commit, gateId: gate.id }).length > 0 || report.label !== "LIVE") return false;
    return report.previewExecuted === true &&
      report.toolOutputHash !== undefined &&
      typeof report.toolOutputHash === "string" &&
      sha64.test(report.toolOutputHash) &&
      report.infrastructureApplied === false;
  }
  if (gate.mode === "ISOLATED_RECOVERY") {
    return report.restoreExecuted === true &&
      typeof report.observedRpoSeconds === "number" &&
      typeof report.observedRtoSeconds === "number" &&
      Number.isFinite(report.observedRpoSeconds) &&
      Number.isFinite(report.observedRtoSeconds) &&
      report.observedRpoSeconds >= 0 && report.observedRtoSeconds >= 0;
  }
  if (gate.mode === "SECURITY_SCAN") {
    return report.imageDigest !== undefined &&
      typeof report.imageDigest === "string" &&
      /^sha256:[0-9a-f]{64}$/.test(report.imageDigest) &&
      report.criticalFindings === 0 && report.highFindings === 0;
  }
  if (gate.mode === "LIVE_METRIC") {
    return report.measurementsAreSynthetic === false &&
      isObject(report.measurements) &&
      Object.keys(report.measurements).length > 0;
  }
  if (gate.mode === "ACT_RECOVERY") {
    // The evidence is a valid recovery-gate document of this commit (src/qualification/recovery-gate.ts): the four gate fields,
    // the conditions, the label and `passed` are recomputed from the cited ledger records, so a hand-written document, or one
    // relabeled over records that show no interruption or an approval carried over, is refused here as well as by the producer.
    // Under a PILOT release the record must name the reviewed contract and the approval count that contract requires for the record's
    // environment (#269 review N2): a PROD record claiming one approval under a contract that requires two is refused.
    return recoveryGateEvidenceProblems(report, { sourceCommit: reportCommit }).length === 0 &&
      typeof report.interruptedArtifactSha256 === "string" && sha64.test(report.interruptedArtifactSha256) &&
      (report.interruptedOutcome === "PARTIAL_REQUIRES_REVIEW" || report.interruptedOutcome === "KILLED") &&
      report.reconciledFromLedger === true && report.resumedWithoutApproval === false &&
      (recoveryBinding === undefined || (report.contractSha256 === recoveryBinding.contractSha256 &&
        report.requiredApprovals === recoveryBinding.requiredApprovals[report.environment as ApplyEnvironment]));
  }
  if (gate.mode === "INDEPENDENT_REVIEW") {
    return typeof report.reviewer === "string" && report.reviewer.trim() !== "" &&
      report.reviewerIsAuthor === false && report.blockingFindingsOpen === 0;
  }
  // A lifecycle or platform report must call itself LIVE, as the live ACT and preview branches require: a synthetic report
  // (label SYNTHETIC, or `synthetic: true`) is refused even when its `fixture` field was dropped by hand.
  const live = report.label === "LIVE" && report.synthetic !== true;
  if (gate.id.startsWith("platform:")) {
    const names = new Set((report.checks as Json[]).map((x) => x.name));
    return live && report.platform === gate.id.slice("platform:".length) && typeof report.osVersion === "string" &&
      report.osVersion.trim() !== "" && typeof report.artifactSha256 === "string" && sha64.test(report.artifactSha256) &&
      PLATFORM_LIFECYCLE_CHECKS.every((name) => names.has(name));
  }
  if (gate.mode === "LIFECYCLE") return live;
  return gate.mode === "CI";
}

async function readEvidence(root: string, path: string): Promise<Buffer> {
  if (!path || isAbsolute(path) || path.includes("\0")) {
    throw new Error("EVIDENCE_PATH_NOT_RELATIVE");
  }
  const resolvedRoot = await realpath(root);
  const candidate = await realpath(resolve(resolvedRoot, path));
  const rel = relative(resolvedRoot, candidate);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    throw new Error("EVIDENCE_PATH_ESCAPES_ROOT");
  }
  return readFile(candidate);
}

/**
 * The pilot exception: a release declares PILOT only together with an enabled
 * pilot contract that authorizes at least one operation (the loader checks the same),
 * and names it (and the one pilot scope) by hash. An enabled contract beside a
 * release that does not declare the pilot is rejected, and so is a stray
 * actPilot or actPilots field on any release that is not PILOT, so neither the contract file
 * nor the manifest can quietly enable ACT for an ordinary release.
 *
 * A PILOT release names its paths one of two ways, never both. `actPilot` is today's single-path form, bound to the contract the
 * candidate carries. `actPilots` is the multi-path form (owner decision 6483993252): each path bound to its own contract, read from
 * the commit that carries it with the same loader, so one candidate can hold valid evidence for every path without one path's
 * contract judging another's evidence. Every check the single form makes is made per path; nothing is inferred or defaulted.
 */
type PilotReview = { scope: ActPilotScope | null; paths: ActPilotPath[]; bindings: PathBinding[]; blockers: string[] };
const CONTRACT_REPO_PATH = PRODUCTION_DEPLOYMENT_CONTRACT.spec.release.actPilot.contract;
const PATH_KEYS = "contractCommit,contractSha256,engine,provider";

function bindingOf(contract: PilotContract, contractCommit: string): PathBinding {
  return {
    gateId: actGateId(contract), contractSha256: pilotContractSha256(contract), contractCommit,
    requiredApprovals: contract.requiredApprovals, applyAuthorizationSha256: applyAuthorizations(contract),
  };
}

async function reviewPilot(manifest: ReleaseAdmissionInput, contract: PilotContract | undefined, candidate: string, contractAt: ContractReader | undefined): Promise<PilotReview> {
  const refuse = (...blockers: string[]): PilotReview => ({ scope: null, paths: [], bindings: [], blockers });
  const single = Object.hasOwn(manifest, "actPilot");
  const multi = Object.hasOwn(manifest, "actPilots");
  if (manifest.infrastructureAct !== "PILOT") {
    return {
      scope: null, paths: [], bindings: [],
      blockers: [
        ...(contract ? ["ACT_PILOT_CONTRACT_ENABLED_FOR_NON_PILOT_RELEASE"] : []),
        ...(single || multi ? ["ACT_PILOT_SCOPE_ON_NON_PILOT_RELEASE"] : []),
      ],
    };
  }
  if (single && multi) return refuse("ACT_PILOT_SCOPE_AMBIGUOUS");
  if (multi) return reviewPilotPaths(manifest.actPilots as unknown, contract, candidate, contractAt);
  if (!contract) return refuse("ACT_PILOT_CONTRACT_MISSING_OR_DISABLED");
  if (Object.keys(contract.authorize ?? {}).length === 0) return refuse("ACT_PILOT_CONTRACT_NOT_AUTHORIZED");
  if (!pilotCombinationListed(contract.provider, contract.engine)) return refuse("ACT_PILOT_COMBINATION_NOT_ALLOWED");
  const claimed = manifest.actPilot as unknown;
  const bound = isObject(claimed) && Object.keys(claimed).length === 3 && claimed.provider === contract.provider &&
    claimed.engine === contract.engine && claimed.contractSha256 === pilotContractSha256(contract);
  return bound
    ? { scope: claimed as ActPilotScope, paths: [], bindings: [bindingOf(contract, candidate)], blockers: [] }
    : refuse("ACT_PILOT_SCOPE_MISMATCH");
}

async function reviewPilotPaths(claimed: unknown, shipped: PilotContract | undefined, candidate: string, contractAt: ContractReader | undefined): Promise<PilotReview> {
  const blockers: string[] = [];
  if (!Array.isArray(claimed) || claimed.length === 0 ||
      !claimed.every((x) => isObject(x) && Object.keys(x).sort().join() === PATH_KEYS && typeof x.contractCommit === "string" && sha40.test(x.contractCommit) &&
        typeof x.contractSha256 === "string" && sha64.test(x.contractSha256))) {
    return { scope: null, paths: [], bindings: [], blockers: ["ACT_PILOT_PATHS_MALFORMED"] };
  }
  const entries = claimed as ActPilotPath[];
  const bindings: PathBinding[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const gateId = actGateId({ provider: String(entry.provider), engine: String(entry.engine) });
    if (seen.has(gateId)) { blockers.push("ACT_PILOT_PATH_DUPLICATE:" + gateId); continue; }
    seen.add(gateId);
    if (!pilotCombinationListed(entry.provider, entry.engine) || !ACT_RELEASE_PATHS.some((x) => actGateId(x) === gateId)) {
      blockers.push("ACT_PILOT_COMBINATION_NOT_ALLOWED:" + gateId);
      continue;
    }
    if (contractAt === undefined) { blockers.push("ACT_PILOT_CONTRACT_SOURCE_UNAVAILABLE:" + gateId); continue; }
    let read: ContractAtCommit;
    try { read = await contractAt(entry.contractCommit); } catch { read = { ok: false, reason: "the reader failed" }; }
    if (!read.ok) { blockers.push("ACT_PILOT_CONTRACT_COMMIT_UNREADABLE:" + gateId); continue; }
    // The commit may differ from the candidate in the contract file only: the code that ran the path's apply is the candidate's.
    if (!read.changedPaths.every((path) => path === CONTRACT_REPO_PATH)) { blockers.push("ACT_PILOT_CONTRACT_COMMIT_CHANGES_PRODUCT:" + gateId); continue; }
    const contract = read.contract;
    if (contract.enabled !== true) { blockers.push("ACT_PILOT_CONTRACT_MISSING_OR_DISABLED:" + gateId); continue; }
    const loaded = contract as PilotContract;
    if (Object.keys(loaded.authorize ?? {}).length === 0) { blockers.push("ACT_PILOT_CONTRACT_NOT_AUTHORIZED:" + gateId); continue; }
    if (loaded.provider !== entry.provider || loaded.engine !== entry.engine || pilotContractSha256(loaded) !== entry.contractSha256) {
      blockers.push("ACT_PILOT_SCOPE_MISMATCH:" + gateId);
      continue;
    }
    bindings.push(bindingOf(loaded, entry.contractCommit));
  }
  // The contract the candidate itself carries, when it enables ACT, must be one of the declared paths' contracts.
  if (shipped && !entries.some((x) => x.contractSha256 === pilotContractSha256(shipped))) blockers.push("ACT_PILOT_SHIPPED_CONTRACT_NOT_DECLARED");
  if (blockers.length > 0) return { scope: null, paths: [], bindings: [], blockers };
  return {
    scope: null, bindings, blockers: [],
    paths: entries.map((x) => ({ provider: x.provider, engine: x.engine, contractSha256: x.contractSha256, contractCommit: x.contractCommit })),
  };
}

/**
 * The default contract reader for a release reviewed in a git checkout at `root`: the contract file as `commit` holds it, judged by
 * `parsePilotContract`, and the paths whose content differs between `candidate` and `commit` (no rename detection, so a moved file
 * shows as two paths). Read-only; it runs git and writes nothing.
 */
export function gitContractReader(root: string, candidate: string): ContractReader {
  const git = (...args: string[]): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
  return async (commit) => {
    if (!sha40.test(commit) || !sha40.test(candidate)) return { ok: false, reason: "not a full commit id" };
    try {
      git("cat-file", "-e", candidate + "^{commit}");
      git("cat-file", "-e", commit + "^{commit}");
      const changedPaths = git("diff", "--no-renames", "--name-only", candidate, commit, "--").split("\n").filter((x) => x !== "");
      let source: string | undefined;
      try { source = git("show", commit + ":" + CONTRACT_REPO_PATH); } catch { source = undefined; }
      return { ok: true, changedPaths, contract: source === undefined ? { enabled: false } : parsePilotContract(source) };
    } catch {
      return { ok: false, reason: "the commit could not be read" };
    }
  };
}

/** The hash of each environment's APPLY authorization in the candidate contract: a live record must name the same one. */
function applyAuthorizations(contract: PilotContract): Partial<Record<ApplyEnvironment, string>> {
  const out: Partial<Record<ApplyEnvironment, string>> = {};
  for (const env of ["DEV", "QA", "PROD"] as const) {
    const authorized = authorizeContract(contract, env, "APPLY");
    if (authorized.ok) out[env] = authorized.authorization.authorizationSha256;
  }
  return out;
}

export async function reviewProductionRelease(input: {
  manifest: ReleaseAdmissionInput;
  root: string;
  expectedCommit: string;
  /** The loaded pilot contract (loadPilotContract). Absent, or not enabled, means there is no pilot. */
  pilotContract?: PilotContract | { enabled: false };
  /** How a multi-path release (`actPilots`) reads each path's contract from its commit. Absent: such a release is refused. */
  contractAt?: ContractReader;
  /** Gates the owner's release scope excludes (config/release/scope.json). They are reported, and do not block; a record for one is refused. */
  outOfScope?: readonly string[];
}): Promise<ReleaseAdmissionReport> {
  const { manifest, expectedCommit } = input;
  const blockers: string[] = [];
  if (!sha40.test(expectedCommit) || manifest.sourceCommit !== expectedCommit ||
      manifest.schemaVersion !== 1 || manifest.operatingMode !== "PREVIEW_OPERATE" ||
      (manifest.infrastructureAct !== "DISABLED" && manifest.infrastructureAct !== "PILOT") ||
      PRODUCTION_DEPLOYMENT_CONTRACT.spec.release.actEnabled !== false) {
    blockers.push("RELEASE_MANIFEST_CONTRACT_OR_COMMIT_INVALID");
  }
  const pilot = await reviewPilot(manifest, input.pilotContract?.enabled === true ? input.pilotContract : undefined, expectedCommit, input.contractAt);
  blockers.push(...pilot.blockers);
  // A PILOT release binds each live ACT and recovery record to its own path's contract; one whose scope did not verify binds nothing.
  const binding: PilotBinding = manifest.infrastructureAct === "PILOT" ? pilot.bindings : null;
  if (!Array.isArray(manifest.records)) {
    blockers.push("RELEASE_RECORDS_REQUIRED");
  }
  const byId = new Map<string, ReleaseGateSubmission>();
  for (const record of Array.isArray(manifest.records) ? manifest.records : []) {
    if (!isObject(record) || typeof record.id !== "string") {
      blockers.push("RELEASE_RECORD_MALFORMED");
      continue;
    }
    if (byId.has(record.id)) blockers.push("RELEASE_RECORD_DUPLICATE:" + record.id);
    if (!PRODUCTION_RELEASE_GATES.some((gate) => gate.id === record.id)) {
      blockers.push("RELEASE_RECORD_UNKNOWN_GATE:" + record.id);
    }
    byId.set(record.id, record as ReleaseGateSubmission);
  }
  const excluded = new Set(input.outOfScope ?? []);
  for (const id of excluded) {
    if (!PRODUCTION_RELEASE_GATES.some((gate) => gate.id === id)) blockers.push("RELEASE_SCOPE_UNKNOWN_GATE:" + id);
  }
  const gates: GateReview[] = [];
  for (const gate of PRODUCTION_RELEASE_GATES) {
    const record = byId.get(gate.id);
    const reasons: string[] = [];
    if (excluded.has(gate.id)) {
      if (record) blockers.push("RELEASE_RECORD_FOR_OUT_OF_SCOPE_GATE:" + gate.id);
      gates.push({ id: gate.id, mode: gate.mode, status: "OUT_OF_SCOPE", blockers: [] });
      continue;
    }
    if (!record) {
      reasons.push("NOT_RUN: no source-bound evidence record");
    } else if (record.mode !== gate.mode ||
        record.sourceCommit !== expectedCommit ||
        !record.targetHardwareId ||
        record.targetHardwareId === "UNKNOWN" ||
        !sha64.test(record.evidenceSha256)) {
      reasons.push("EVIDENCE_IDENTITY_MISMATCH");
    } else {
      try {
        const bytes = await readEvidence(input.root, record.evidencePath);
        if (digest(bytes) !== record.evidenceSha256) {
          reasons.push("EVIDENCE_DIGEST_MISMATCH");
        } else {
          const value = JSON.parse(bytes.toString("utf8")) as unknown;
          if (!observedLivePayload(value, gate, record, expectedCommit, binding)) {
            reasons.push("EVIDENCE_GATE_CONTRACT_FAILED");
          }
        }
      } catch {
        reasons.push("EVIDENCE_MISSING_INVALID_OR_OUTSIDE_ROOT");
      }
    }
    gates.push({ id: gate.id, mode: gate.mode,
      status: reasons.length ? "BLOCKED" : "EVIDENCE_PRESENT",
      blockers: reasons,
      ...(record ? { evidenceSha256: record.evidenceSha256 } : {}),
    });
  }
  const candidateIdentityHash = digest(JSON.stringify({
    sourceCommit: expectedCommit,
    gates: gates.map((gate) => [gate.id, gate.status, gate.evidenceSha256]),
  }));
  const readyForIndependentReleaseReview =
    blockers.length === 0 && gates.every((gate) => gate.status !== "BLOCKED");
  return {
    sourceCommit: expectedCommit,
    readyForIndependentReleaseReview,
    productionReleaseApproved: false,
    infrastructureAct: "DISABLED",
    actPilot: pilot.scope,
    actPilots: pilot.paths,
    gates,
    blockers: [...blockers, ...gates.filter((gate) =>
      gate.status === "BLOCKED").map((gate) =>
      gate.id + ": " + gate.blockers.join(", "))],
    candidateIdentityHash,
  };
}

/**
 * The admission review of a release from this repository: the pilot contract it ships (config/act-pilot-contract.json),
 * and the gates the owner's scope excludes. The one entry both the admission CLI and the release status view use.
 */
export function reviewRepositoryRelease(input: { manifest: ReleaseAdmissionInput; root: string; expectedCommit: string; outOfScope: readonly string[] }): Promise<ReleaseAdmissionReport> {
  // ACT is off unless the release declares PILOT and the shipped contract is valid, enabled and authorizes an operation.
  return reviewProductionRelease({ ...input, pilotContract: loadPilotContract(), contractAt: gitContractReader(input.root, input.expectedCommit) });
}
