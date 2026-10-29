import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { loadModelDigestPins, normalizeDigest, type ModelDigestPins } from "../models/digest-pins.js";
import { promptPolicyHash } from "../security/prompt-governance.js";
import { pilotCombinationListed } from "../qualification/production-contract.js";
import { actGateId, RELEASE_PLATFORMS } from "../qualification/release-admission.js";
import { sha256 } from "../util/sha256.js";
import { checkJourneyMatrix, loadJourneyMatrix, REQUIRED_ROWS, type RowReport } from "./acceptance.js";
import { validateReleaseManifest, type PreviewOperateReleaseManifest } from "./manifest.js";
import { describeFindings, EXCLUSION_RULES, pathExclusions, type ExclusionCode } from "./package-exclusions.js";
import { loadReleaseScope, loadReleaseStatus, type GateStatusEntry, type ReleaseStatus } from "./status.js";

/**
 * The field package manifest (owner decision 2026-10-29, "Close ACT enablement blockers", item 4; docs/field-package.md).
 *
 * It describes one supervised DEV ACT pilot package for one accepted source commit, and claims nothing it cannot read from a
 * file. Artifact digests come from the archive, release manifest and SBOM files a person passes in, never from typed values;
 * a missing input is PENDING. Scan results come from the scanners' own output files, else NOT_RUN. A platform is supported
 * only when its `platform:*` gate passed for this commit with LIVE evidence. A model digest is listed only when it is the
 * committed pin and a `./alz models verify` record shows that exact digest installed and qualified; otherwise the model is
 * MODEL_DIGEST_UNPINNED or NOT_VERIFIED. A path is live-qualified only when its `act:*` gate passed for this commit and its
 * journey row is LIVE_PASS. The default installation is ACT DISABLED, and the package carries no contract.
 *
 * Offline and read-only: nothing here contacts a network, runs an engine or a model, or writes outside the output folder the
 * CLI is given. The result has no timestamp, so the same inputs give the same bytes.
 */

export type FileDigest = { status: "PRESENT"; file: string; sha256: string };
export type Pending = { status: "PENDING"; reason: string };
export type NotRun = { status: "NOT_RUN"; reason: string };

export type ContractAdmission = "ADMITTED" | "NOT_ADMITTED";
export type PathRow = {
  path: number;
  provider: string;
  engine: string;
  title: string;
  /** NOT_AVAILABLE when the product does not admit the path at all; otherwise the package offers it for DEV only. */
  packageScope: "DEV_ONLY" | "NOT_AVAILABLE";
  capability: {
    contractAdmission: ContractAdmission;
    /** The journey row's weakest step (config/acceptance/journeys.json, checked by src/release/acceptance.ts). */
    journeyStatus: string;
    /** True only when every step through cleanup and every row proof passes synthetically. */
    implementedThroughCleanup: boolean;
  };
  actGate: { id: string; status: string; evidenceMode: string | null } | { id: null; status: "NO_GATE" };
  liveQualification: "LIVE_QUALIFIED" | "NOT_QUALIFIED" | "NOT_AVAILABLE";
  docs: string[];
};

export type ModelEntry = {
  model: string;
  pinnedDigest: string | null;
  status: "VERIFIED" | "MODEL_DIGEST_UNPINNED" | "NOT_VERIFIED" | "MODEL_DIGEST_MISMATCH";
  reason: string;
};

export type SeverityCounts = Record<string, number>;
export type FieldPackageManifest = {
  schemaVersion: 1;
  kind: "SUPERVISED_DEV_ACT_PILOT";
  statement: string;
  act: { defaultInstallation: "DISABLED"; packagedContract: "NONE"; enablement: string };
  source: { commit: string; frozenCandidate: boolean; acceptance: "PENDING_OWNER" };
  artifacts: {
    archive: FileDigest | Pending;
    releaseManifest: FileDigest | Pending;
    sbom: FileDigest | Pending;
    runtimeImage: Pending;
  };
  exclusionCheck: { status: "PASS" | "PENDING"; scope: string; refused: { code: ExclusionCode; rule: string }[] };
  dependencyLocks: { file: string; sha256: string; kind: "npm" | "terraform"; providers?: { source: string; version: string }[] }[];
  toolPins: { file: string; sha256: string; tools: { tool: string; version: string }[] };
  scans: {
    sbom: { status: "PRESENT"; format: string; specVersion: string | null; components: number } | NotRun;
    trivy: { status: "RESULTS"; file: string; sha256: string; artifact: string | null; targets: number; vulnerabilities: SeverityCounts; misconfigurations: SeverityCounts; configuredIn: string } | NotRun;
    npmAudit: { status: "RESULTS"; file: string; sha256: string; vulnerabilities: SeverityCounts } | NotRun;
  };
  platforms: { platform: string; gate: string; status: string; supported: boolean }[];
  supportedPlatforms: string[];
  models: { runtime: { tool: "ollama"; pinnedVersion: string | null; gate: string; gateStatus: string }; evidence: FileDigest | NotRun; entries: ModelEntry[] };
  paths: PathRow[];
  knownLimitations: { gate: string; status: string; nextAction: string }[];
  outOfScope: { gate: string; reason: string }[];
  followUps: { id: string; title: string; status: string }[];
  boundaries: { financial: string[]; customerData: string[] };
  notPackaged: { code: ExclusionCode; rule: string }[];
};

export type FieldPackageInputs = {
  sourceCommit: string;
  archive?: { file: string; bytes: Buffer };
  archiveSha256File?: { file: string; text: string };
  releaseManifest?: { file: string; bytes: Buffer };
  sbom?: { file: string; bytes: Buffer };
  trivy?: { file: string; bytes: Buffer };
  npmAudit?: { file: string; bytes: Buffer };
  modelsEvidence?: { file: string; bytes: Buffer };
};

/** What the generator reads from the repository at the source commit. Loaded by `readRepositoryFacts`, typed for tests. */
export type RepositoryFacts = {
  status: ReleaseStatus;
  scope: { candidate: string | null; outOfScope: { gate: string; reason: string }[] };
  journeys: RowReport[];
  journeyProblems: string[];
  workGraph: { id: string; title: string; status: string }[];
  modelPins: ModelDigestPins;
  toolPins: { sha256: string; raw: Record<string, unknown> };
  locks: { file: string; bytes: Buffer }[];
};

export class FieldPackageRefusal extends Error {
  constructor(readonly code: string, message: string) { super(code + ": " + message); }
}
const refuse = (code: string, message: string): never => { throw new FieldPackageRefusal(code, message); };

const COMMIT = /^[0-9a-f]{40}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const digestOf = (input: { file: string; bytes: Buffer }): FileDigest => ({ status: "PRESENT", file: input.file, sha256: sha256(input.bytes) });
const pending = (reason: string): Pending => ({ status: "PENDING", reason });
const notRun = (reason: string): NotRun => ({ status: "NOT_RUN", reason });
const json = (input: { file: string; bytes: Buffer }, code: string): unknown => {
  try { return JSON.parse(input.bytes.toString("utf8")); } catch { return refuse(code, input.file + " is not JSON"); }
};

/** The six paths of the narrow ACT-DEV release, in journey order, with the pages a pilot operator reads for each. */
const PATH_DOCS: Readonly<Record<string, { title: string; docs: string[] }>> = {
  "AWS TERRAFORM": { title: "AWS Terraform", docs: ["docs/act-dev-1.md", "docs/act-dev-enablement.md"] },
  "AWS CDK": { title: "AWS CDK / CloudFormation", docs: ["docs/act-pilot-simulation-cdk.md", "docs/act-pilot-apply.md"] },
  "AZURE TERRAFORM": { title: "Azure Terraform", docs: ["docs/act-dev-enablement.md", "docs/act-pilot-apply.md"] },
  "AZURE BICEP": { title: "Azure Bicep / ARM", docs: ["docs/act-pilot-bicep.md"] },
  "GCP TERRAFORM": { title: "GCP Terraform", docs: ["docs/act-pilot-gcp-terraform-g0.md", "docs/act-pilot-bootstrap-gcp.md"] },
  "GCP GCP_API": { title: "GCP API-native", docs: ["docs/act-pilot-gcp-api.md"] },
};

/**
 * Whether the product admits a path at all: the accepted ProductionDeploymentContract lists every provider and engine pair a
 * pilot contract may name (src/qualification/production-contract.ts), and nothing else is a pilot. The contract validator
 * then keeps Azure Bicep and GCP Terraform DEV-only (docs/act-pilot-apply.md); this package offers every admitted path for
 * DEV only.
 */
export function contractAdmissionOf(provider: string, engine: string): ContractAdmission {
  return pilotCombinationListed(provider, engine) ? "ADMITTED" : "NOT_ADMITTED";
}

function lockProviders(text: string): { source: string; version: string }[] {
  const out: { source: string; version: string }[] = [];
  const block = /provider\s+"([^"]+)"\s*\{([\s\S]*?)\n\}/g;
  for (let match = block.exec(text); match !== null; match = block.exec(text)) {
    const version = /\n\s*version\s*=\s*"([^"]+)"/.exec(match[2]);
    out.push({ source: match[1], version: version ? version[1] : "UNSTATED" });
  }
  return out;
}

function counts(items: unknown[], key = "Severity"): SeverityCounts {
  const out: SeverityCounts = {};
  for (const item of items) {
    const severity = isRecord(item) && typeof item[key] === "string" ? (item[key] as string).toUpperCase() : "UNKNOWN";
    out[severity] = (out[severity] ?? 0) + 1;
  }
  return out;
}

function trivySummary(input: { file: string; bytes: Buffer }): FieldPackageManifest["scans"]["trivy"] {
  const value = json(input, "FIELD_TRIVY_INVALID");
  if (!isRecord(value) || !Array.isArray(value.Results)) return refuse("FIELD_TRIVY_INVALID", input.file + " is not a Trivy JSON report (no Results list)");
  const results = value.Results.filter(isRecord);
  const vulnerabilities = counts(results.flatMap((r) => Array.isArray(r.Vulnerabilities) ? r.Vulnerabilities : []));
  const misconfigurations = counts(results.flatMap((r) => Array.isArray(r.Misconfigurations) ? r.Misconfigurations : []));
  return {
    status: "RESULTS", file: input.file, sha256: sha256(input.bytes),
    artifact: typeof value.ArtifactName === "string" ? value.ArtifactName : null, targets: results.length,
    vulnerabilities, misconfigurations,
    configuredIn: ".github/workflows/supply-chain.yml, step \"Scan vulnerabilities and IaC configuration\"",
  };
}

function auditSummary(input: { file: string; bytes: Buffer }): FieldPackageManifest["scans"]["npmAudit"] {
  const value = json(input, "FIELD_AUDIT_INVALID");
  const found = isRecord(value) && isRecord(value.metadata) && isRecord(value.metadata.vulnerabilities) ? value.metadata.vulnerabilities : undefined;
  if (found === undefined) return refuse("FIELD_AUDIT_INVALID", input.file + " is not npm audit --json output (no metadata.vulnerabilities)");
  const vulnerabilities: SeverityCounts = {};
  for (const [key, count] of Object.entries(found)) {
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) refuse("FIELD_AUDIT_INVALID", input.file + " has a count that is not a whole number");
    vulnerabilities[key] = count as number;
  }
  return { status: "RESULTS", file: input.file, sha256: sha256(input.bytes), vulnerabilities };
}

/** A marker that a record was made by a fixture, a simulation or a synthetic run, anywhere in the object or its records. */
const syntheticMarker = (value: Record<string, unknown>): boolean =>
  value.fixture === true || value.mock === true || value.simulation === true ||
  value.evidenceMode === "SYNTHETIC" || value.label === "SYNTHETIC" || value.mode === "OFFLINE_FIXTURE_ONLY";

/**
 * Why a `./alz models verify --production` run cannot vouch for any model of this commit, or undefined when it can. The run must
 * be the production qualification on the target host (the same shape the release admission review's private-model gate
 * requires: production context, session, checks and stack checks all passed), bound to this commit, made under the prompt
 * policy this commit ships, passed as a whole, and carry no fixture or synthetic marker. `./alz models verify` writes no LIVE
 * label of its own: a production run on the target host with no synthetic marker is the strongest claim its output can make.
 */
export function modelRunProblem(evidence: unknown, commit: string): string | undefined {
  if (!isRecord(evidence) || !Array.isArray(evidence.records)) return "not ./alz models verify output";
  if (syntheticMarker(evidence) || evidence.records.some((r) => isRecord(r) && syntheticMarker(r))) return "it is marked as a fixture or synthetic run";
  if (evidence.passed !== true) return "the run as a whole did not pass";
  if (evidence.policyHash !== promptPolicyHash()) return "it was made under another prompt policy than this commit ships";
  const production = evidence.production;
  if (!isRecord(production) || !isRecord(production.context)) return "it is not a --production run, so it names no commit or target host";
  if (production.context.sourceCommit !== commit) return "it was made from another commit";
  if (production.passed !== true || !isRecord(production.session) || production.session.mutationObserved !== false ||
      !Array.isArray(production.checks) || production.checks.length === 0 || !production.checks.every((x) => isRecord(x) && x.passed === true)) {
    return "its production qualification did not pass";
  }
  const stack = evidence.stackChecks;
  if (!Array.isArray(stack) || stack.length === 0 || !stack.every((x) => isRecord(x) && x.passed === true)) return "its default-stack checks did not pass";
  return undefined;
}

function modelEntries(pins: ModelDigestPins, evidence: unknown, commit: string): ModelEntry[] {
  const records = isRecord(evidence) && Array.isArray(evidence.records) ? evidence.records.filter(isRecord) : [];
  const runProblem = evidence === undefined ? undefined : modelRunProblem(evidence, commit);
  return pins.models.map((model): ModelEntry => {
    const pinned = pins.digests.get(model) ?? null;
    if (pinned === null) {
      return { model, pinnedDigest: null, status: "MODEL_DIGEST_UNPINNED", reason: "config/tool-pins.json records no digest for this model (owner input); no digest is listed or guessed." };
    }
    if (evidence === undefined) {
      return { model, pinnedDigest: pinned, status: "NOT_VERIFIED", reason: "No ./alz models verify record for this model was given." };
    }
    if (runProblem !== undefined) {
      return { model, pinnedDigest: pinned, status: "NOT_VERIFIED", reason: "The ./alz models verify run cannot vouch for this commit: " + runProblem + "." };
    }
    const record = records.find((r) => r.model === model);
    if (record === undefined) {
      return { model, pinnedDigest: pinned, status: "NOT_VERIFIED", reason: "The ./alz models verify run has no record for this model." };
    }
    if (normalizeDigest(record.digest) !== pinned || record.digestCheck !== "PINNED" || normalizeDigest(record.pinnedDigest) !== pinned) {
      return { model, pinnedDigest: pinned, status: "MODEL_DIGEST_MISMATCH", reason: "The ./alz models verify record does not show the committed pin installed." };
    }
    if (record.passed !== true || record.policyHash !== promptPolicyHash()) {
      return { model, pinnedDigest: pinned, status: "NOT_VERIFIED", reason: "The pinned digest is installed, but its qualification did not pass under this commit's prompt policy." };
    }
    return { model, pinnedDigest: pinned, status: "VERIFIED", reason: "A passed ./alz models verify --production run of this commit shows the pinned digest installed and qualified." };
  });
}

const FINANCIAL = [
  "The package authorizes no spending. Every cloud resource is created in the customer's own accounts, subscriptions or projects, and billed there.",
  "Cost estimates in the canary documentation are estimates, not a spending authorization; the owner names a maximum amount and a retention period before any run.",
  "Budgets, alerts and spending limits are the customer's. The field package creates and changes none; the owner-run bootstrap (bootstrap/, not in the package) can create a monthly budget with alerts from the owner's own values, and a budget alerts but never stops spending (docs/act-pilot-bootstrap.md, \"Budget and cost alerts\").",
  "ACT is DISABLED by default. Nothing in the package plans, applies or cleans up infrastructure until the owner commits a reviewed contract that authorizes one DEV target and path.",
];
const CUSTOMER_DATA = [
  "Evidence, ledgers, sealed plans and approvals are written only on the operator's host, under .runs/ in the installation, with private file modes.",
  "The package uploads no evidence and sends no usage data to its authors. Private models run on the local loopback runtime. Outbound calls are the ones a person starts: the cloud API calls of read-only and pilot commands against the customer's own accounts, the pinned tool downloads of ./alz deps after a typed yes, and any monitoring export the operator configures (docs/observability.md).",
  "Retention is the operator's. Evidence stays until the operator removes it: removing a run's working files (./alz apply remove-workspace) is its own approved operation and keeps the evidence directory. The package never ships evidence (the exclusion guard refuses .runs/).",
  "Evidence can carry account, subscription and project identifiers and resource names. Redact it before sharing it outside the customer's organization.",
];

/** Builds the manifest from typed inputs. Throws FieldPackageRefusal for an input that contradicts another or the commit. */
export function buildFieldPackage(inputs: FieldPackageInputs, facts: RepositoryFacts): FieldPackageManifest {
  const commit = inputs.sourceCommit;
  if (!COMMIT.test(commit)) refuse("FIELD_SOURCE_COMMIT_INVALID", "the source commit must be 40 lowercase hex characters");
  if (facts.journeyProblems.length > 0) refuse("FIELD_JOURNEY_MATRIX_INVALID", facts.journeyProblems.slice(0, 3).join("; "));

  // Artifacts: only what the files show, cross-checked against each other.
  const archive = inputs.archive ? digestOf(inputs.archive) : undefined;
  if (inputs.archiveSha256File) {
    const listed = /^([0-9a-f]{64})\b/.exec(inputs.archiveSha256File.text.trim());
    if (!listed) refuse("FIELD_ARCHIVE_CHECKSUM_INVALID", inputs.archiveSha256File.file + " does not start with a SHA-256");
    if (!archive) refuse("FIELD_ARCHIVE_MISSING", "a checksum file was given without the archive it describes");
    if (listed![1] !== archive!.sha256) refuse("FIELD_ARCHIVE_CHECKSUM_MISMATCH", "the archive's SHA-256 is not the one its checksum file lists");
  }
  let manifest: PreviewOperateReleaseManifest | undefined;
  if (inputs.releaseManifest) {
    const value = json(inputs.releaseManifest, "FIELD_RELEASE_MANIFEST_INVALID");
    if (!isRecord(value) || !Array.isArray(value.files) || !isRecord(value.contract) || !isRecord(value.sbom) || !isRecord(value.lifecycle)) {
      refuse("FIELD_RELEASE_MANIFEST_INVALID", inputs.releaseManifest.file + " is not a release manifest");
    }
    manifest = value as PreviewOperateReleaseManifest;
    const blockers = validateReleaseManifest(manifest);
    if (blockers.length > 0) refuse("FIELD_RELEASE_MANIFEST_INVALID", blockers.join(" "));
    if (manifest.sourceCommit !== commit) refuse("FIELD_RELEASE_MANIFEST_COMMIT_MISMATCH", "the release manifest names " + manifest.sourceCommit + ", not " + commit);
    const excluded = manifest.files.flatMap((file) => pathExclusions(file.path));
    if (excluded.length > 0) refuse("FIELD_PACKAGE_EXCLUDED_CONTENT", describeFindings(excluded).join("; "));
  }
  // The archive is bound to the commit through the release manifest it carries: that manifest must be byte for byte the one
  // given (which names this commit), every file it lists must be in the archive with its hash, and nothing else may be.
  if (archive) {
    if (!inputs.releaseManifest || !manifest) refuse("FIELD_ARCHIVE_UNBOUND", "an archive needs --release-manifest, which binds it to the commit");
    let entries: Map<string, Buffer>;
    try { entries = tarFiles(inputs.archive!.bytes); } catch (error) {
      return refuse("FIELD_ARCHIVE_UNREADABLE", inputs.archive!.file + " is not a readable gzip tar archive (" + (error instanceof Error ? error.message : "unreadable") + ")");
    }
    const inside = entries.get("release-manifest.json");
    if (!inside || !inside.equals(inputs.releaseManifest!.bytes)) refuse("FIELD_ARCHIVE_MANIFEST_MISMATCH", "the archive's release-manifest.json is not the release manifest given for " + commit);
    const listed = new Map(manifest!.files.map((file) => [file.path, file.sha256]));
    for (const [path, bytes] of entries) {
      if (path === "release-manifest.json") continue;
      const expected = listed.get(path);
      if (expected === undefined) refuse("FIELD_ARCHIVE_UNLISTED_FILE", "the archive holds " + path + ", which its release manifest does not list");
      if (sha256(bytes) !== expected) refuse("FIELD_ARCHIVE_CONTENT_MISMATCH", "the archive's " + path + " is not the file its release manifest hashes");
    }
    for (const path of listed.keys()) if (!entries.has(path)) refuse("FIELD_ARCHIVE_CONTENT_MISMATCH", "the archive lacks " + path + ", which its release manifest lists");
  }
  const sbom = inputs.sbom ? digestOf(inputs.sbom) : undefined;
  if (sbom && manifest && manifest.sbom.sha256 !== sbom.sha256) refuse("FIELD_SBOM_MISMATCH", "the SBOM's SHA-256 is not the one the release manifest binds");
  let sbomScan: FieldPackageManifest["scans"]["sbom"] = notRun("No SBOM file was given.");
  if (inputs.sbom) {
    const value = json(inputs.sbom, "FIELD_SBOM_INVALID");
    if (!isRecord(value) || value.bomFormat !== "CycloneDX") refuse("FIELD_SBOM_INVALID", inputs.sbom.file + " is not a CycloneDX SBOM");
    const bom = value as Record<string, unknown>;
    sbomScan = { status: "PRESENT", format: "CycloneDX", specVersion: typeof bom.specVersion === "string" ? bom.specVersion : null, components: Array.isArray(bom.components) ? bom.components.length : 0 };
  }

  const gate = (id: string): GateStatusEntry | undefined => facts.status.gates.find((x) => x.gate === id);
  const passedHere = (entry: GateStatusEntry | undefined) => entry?.status === "PASS" && entry.evidenceMode === "LIVE" && entry.candidate === commit;

  const platforms = RELEASE_PLATFORMS.map((platform) => {
    const entry = gate("platform:" + platform);
    return { platform, gate: "platform:" + platform, status: entry?.status ?? "NO_GATE", supported: passedHere(entry) };
  });

  const paths = REQUIRED_ROWS.map((row, index): PathRow => {
    const key = row.cloud + " " + row.path;
    const report = facts.journeys.find((x) => x.cloud === row.cloud && x.path === row.path);
    const admission = contractAdmissionOf(row.cloud, row.path);
    const available = admission === "ADMITTED";
    const gateId = actGateId({ provider: row.cloud, engine: row.path });
    const entry = gate(gateId);
    const live = available && report?.live === "LIVE_PASS" && passedHere(entry);
    return {
      path: index + 1, provider: row.cloud, engine: row.path, title: PATH_DOCS[key]?.title ?? key,
      packageScope: available ? "DEV_ONLY" : "NOT_AVAILABLE",
      capability: { contractAdmission: admission, journeyStatus: report?.status ?? "NOT_IMPLEMENTED", implementedThroughCleanup: report?.implemented ?? false },
      actGate: entry ? { id: gateId, status: entry.status, evidenceMode: entry.evidenceMode } : { id: null, status: "NO_GATE" },
      liveQualification: !available ? "NOT_AVAILABLE" : live ? "LIVE_QUALIFIED" : "NOT_QUALIFIED",
      docs: PATH_DOCS[key]?.docs ?? [],
    };
  });

  const toolVersion = (value: unknown): string | null => isRecord(value) && typeof value.version === "string" ? value.version : null;
  const raw = facts.toolPins.raw;
  const tools: { tool: string; version: string }[] = [];
  for (const [tool, value] of Object.entries(isRecord(raw.tools) ? raw.tools : {})) { const v = toolVersion(value); if (v) tools.push({ tool, version: v }); }
  for (const tool of ["awsCli", "azureCli", "bicep"]) { const v = toolVersion(raw[tool]); if (v) tools.push({ tool, version: v }); }
  if (isRecord(raw.node) && typeof raw.node.major === "number") tools.push({ tool: "node", version: String(raw.node.major) + ".x" });

  const modelGate = gate("private-model-runtime");
  const modelsEvidence = inputs.modelsEvidence ? json(inputs.modelsEvidence, "FIELD_MODELS_EVIDENCE_INVALID") : undefined;
  if (inputs.modelsEvidence && !(isRecord(modelsEvidence) && Array.isArray(modelsEvidence.records))) {
    refuse("FIELD_MODELS_EVIDENCE_INVALID", inputs.modelsEvidence.file + " is not ./alz models verify output (no records list)");
  }

  const excluded = new Set(facts.scope.outOfScope.map((x) => x.gate));
  return {
    schemaVersion: 1,
    kind: "SUPERVISED_DEV_ACT_PILOT",
    statement: "A supervised DEV ACT pilot package for an owner-run pilot in the customer's own DEV accounts. It is not a production deployment product, and it claims no platform support or cloud-path qualification beyond the evidence listed here.",
    act: {
      defaultInstallation: "DISABLED",
      packagedContract: "NONE",
      enablement: "An operator enables only an explicitly reviewed target and path: the owner's reviewed commit of config/act-pilot-contract.json with one authorize entry for DEV (docs/field-package.md).",
    },
    source: { commit, frozenCandidate: facts.scope.candidate === commit, acceptance: "PENDING_OWNER" },
    artifacts: {
      archive: archive ?? pending("No release archive was given (supply-chain.yml stages .runs/release/agent-private-landing-zone.tar.gz)."),
      releaseManifest: inputs.releaseManifest ? digestOf(inputs.releaseManifest) : pending("No release-manifest.json was given."),
      sbom: sbom ?? pending("No sbom.cdx.json was given."),
      runtimeImage: pending("The ARM64 runtime image digest comes from the arm64-final-image gate (status " + (gate("arm64-final-image")?.status ?? "NO_GATE") + "); it is not read from a file here."),
    },
    exclusionCheck: manifest
      ? { status: "PASS", scope: archive ? "every file in the archive, bound file by file to its release manifest, by name; the build checked every file's content (src/cli/release-package.ts)" : "every file the release manifest names, by name; the build checked every file's content (src/cli/release-package.ts)", refused: Object.entries(EXCLUSION_RULES).map(([code, rule]) => ({ code: code as ExclusionCode, rule })) }
      : { status: "PENDING", scope: "no release manifest was given", refused: Object.entries(EXCLUSION_RULES).map(([code, rule]) => ({ code: code as ExclusionCode, rule })) },
    dependencyLocks: facts.locks.map((lock) => lock.file.endsWith(".terraform.lock.hcl")
      ? { file: lock.file, sha256: sha256(lock.bytes), kind: "terraform" as const, providers: lockProviders(lock.bytes.toString("utf8")) }
      : { file: lock.file, sha256: sha256(lock.bytes), kind: "npm" as const }),
    toolPins: { file: "config/tool-pins.json", sha256: facts.toolPins.sha256, tools },
    scans: {
      sbom: sbomScan,
      trivy: inputs.trivy ? trivySummary(inputs.trivy) : notRun("No Trivy JSON report was given."),
      npmAudit: inputs.npmAudit ? auditSummary(inputs.npmAudit) : notRun("No npm audit --json output was given."),
    },
    platforms,
    supportedPlatforms: platforms.filter((x) => x.supported).map((x) => x.platform),
    models: {
      runtime: { tool: "ollama", pinnedVersion: toolVersion(isRecord(raw.tools) ? raw.tools.ollama : undefined), gate: "private-model-runtime", gateStatus: modelGate?.status ?? "NO_GATE" },
      evidence: inputs.modelsEvidence ? digestOf(inputs.modelsEvidence) : notRun("No ./alz models verify output was given."),
      entries: modelEntries(facts.modelPins, modelsEvidence, commit),
    },
    paths,
    knownLimitations: facts.status.gates
      .filter((x) => x.status !== "PASS" && !excluded.has(x.gate))
      .map((x) => ({ gate: x.gate, status: x.status, nextAction: x.nextAction })),
    outOfScope: facts.scope.outOfScope.map((x) => ({ gate: x.gate, reason: x.reason })),
    followUps: facts.workGraph.filter((x) => x.status !== "DONE"),
    boundaries: { financial: FINANCIAL, customerData: CUSTOMER_DATA },
    notPackaged: Object.entries(EXCLUSION_RULES).map(([code, rule]) => ({ code: code as ExclusionCode, rule })),
  };
}

/**
 * The regular files of a gzip tar archive (ustar, GNU long names, pax paths), by normalized path, read in memory without
 * extracting anything. A link or any other entry type that is not a directory is refused, as the package guard refuses it.
 */
export function tarFiles(gz: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(gz, { maxOutputLength: 1024 * 1024 * 1024 });
  const files = new Map<string, Buffer>();
  const text = (from: number, length: number) => { const raw = tar.subarray(from, from + length); const end = raw.indexOf(0); return raw.subarray(0, end < 0 ? raw.length : end).toString("utf8"); };
  let offset = 0;
  let longName: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = parseInt(text(offset + 124, 12).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0) throw new Error("bad entry size");
    const type = String.fromCharCode(header[156] || 48);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    if (body.length !== size) throw new Error("truncated entry");
    const prefix = text(offset + 345, 155);
    let name = longName ?? (prefix ? prefix + "/" : "") + text(offset, 100);
    longName = undefined;
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") { longName = body.toString("utf8").replace(/\0+$/, ""); continue; }
    if (type === "x") { const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8")); if (path) longName = path[1]; continue; }
    if (type === "g") continue;
    name = name.replace(/^(?:\.\/)+/, "").replace(/\/$/, "");
    if (type === "5") continue;
    if (type !== "0" && type !== "\0" && type !== "7") throw new Error("entry " + name + " is not a regular file");
    if (name === "" || name.split("/").includes("..")) throw new Error("unsafe entry name");
    files.set(name, Buffer.from(body));
  }
  return files;
}

/** The dependency lock files the package's canaries and runtime are built from: the root npm lock and every canary lock. */
function lockFiles(root: string): string[] {
  const out = ["package-lock.json"];
  const walk = (relative: string) => {
    let names: string[];
    try { names = readdirSync(join(root, relative), { withFileTypes: true }).map((d) => (d.isDirectory() ? d.name + "/" : d.name)).sort(); } catch { return; }
    for (const name of names) {
      if (name === "node_modules/" || name === ".terraform/") continue;
      const path = relative + "/" + name.replace(/\/$/, "");
      if (name.endsWith("/")) walk(path);
      else if (name === ".terraform.lock.hcl" || name === "package-lock.json") out.push(path);
    }
  };
  walk("qualification");
  return out;
}

/** Reads the repository facts at `root`. Every file is read as committed text; nothing is fetched or run. */
export function readRepositoryFacts(root: string): RepositoryFacts {
  const scope = loadReleaseScope(root);
  const matrix = checkJourneyMatrix(loadJourneyMatrix(root), root);
  const graph = JSON.parse(readFileSync(join(root, "config", "release", "work-graph.json"), "utf8")) as { nodes?: unknown };
  const toolPinsBytes = readFileSync(join(root, "config", "tool-pins.json"));
  return {
    status: loadReleaseStatus(root) as ReleaseStatus,
    scope: { candidate: scope.candidate, outOfScope: scope.outOfScope },
    journeys: matrix.rows,
    journeyProblems: matrix.problems,
    workGraph: (Array.isArray(graph.nodes) ? graph.nodes : []).filter(isRecord)
      .map((n) => ({ id: String(n.id), title: String(n.title), status: String(n.status) })),
    modelPins: loadModelDigestPins(join(root, "config", "tool-pins.json")),
    toolPins: { sha256: sha256(toolPinsBytes), raw: JSON.parse(toolPinsBytes.toString("utf8")) as Record<string, unknown> },
    locks: lockFiles(root).filter((file) => existsSync(join(root, file))).map((file) => ({ file, bytes: readFileSync(join(root, file)) })),
  };
}

const cell = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", " ");
const digestText = (value: FileDigest | Pending | NotRun) => value.status === "PRESENT" ? "`" + value.sha256 + "` (" + value.file + ")" : value.status + ": " + value.reason;
const severityText = (value: SeverityCounts) => Object.keys(value).length === 0 ? "none" : Object.entries(value).sort().map(([k, v]) => k + " " + v).join(", ");

/** The rendered companion of field-package.json: the same facts, for a person. Generated; never edited by hand. */
export function renderFieldPackage(m: FieldPackageManifest): string {
  const scans = m.scans;
  return [
    "# Field package manifest",
    "",
    "<!-- Generated by scripts/field-package.ts from field-package.json. Do not edit by hand. Guide: docs/field-package.md. -->",
    "",
    "**Kind:** supervised DEV ACT pilot. " + m.statement,
    "",
    "**ACT:** " + m.act.defaultInstallation + " by default. Packaged contract: " + m.act.packagedContract + ". " + m.act.enablement,
    "",
    "**Source commit:** `" + m.source.commit + "` (frozen candidate: " + (m.source.frozenCandidate ? "yes" : "no") + "; acceptance: " + m.source.acceptance + ").",
    "",
    "## Artifacts",
    "",
    "| Artifact | SHA-256 |",
    "| --- | --- |",
    "| Release archive | " + cell(digestText(m.artifacts.archive)) + " |",
    "| Release manifest | " + cell(digestText(m.artifacts.releaseManifest)) + " |",
    "| SBOM (CycloneDX) | " + cell(digestText(m.artifacts.sbom)) + " |",
    "| Runtime image (ARM64) | " + cell(digestText(m.artifacts.runtimeImage)) + " |",
    "",
    "Exclusion check: **" + m.exclusionCheck.status + "** (" + m.exclusionCheck.scope + ").",
    "",
    "## Dependency locks and tool pins",
    "",
    "| File | SHA-256 | Providers |",
    "| --- | --- | --- |",
    ...m.dependencyLocks.map((x) => "| `" + x.file + "` | `" + x.sha256 + "` | " + (x.providers ? x.providers.map((p) => p.source + " " + p.version).join(", ") : "npm") + " |"),
    "| `" + m.toolPins.file + "` | `" + m.toolPins.sha256 + "` | " + m.toolPins.tools.map((t) => t.tool + " " + t.version).join(", ") + " |",
    "",
    "## Scans",
    "",
    "- SBOM: " + (scans.sbom.status === "PRESENT" ? "CycloneDX " + (scans.sbom.specVersion ?? "") + ", " + scans.sbom.components + " components" : "NOT_RUN: " + scans.sbom.reason),
    "- Trivy: " + (scans.trivy.status === "RESULTS" ? "vulnerabilities " + severityText(scans.trivy.vulnerabilities) + "; misconfigurations " + severityText(scans.trivy.misconfigurations) + " (" + scans.trivy.targets + " targets; configured in " + scans.trivy.configuredIn + ")" : "NOT_RUN: " + scans.trivy.reason),
    "- npm audit: " + (scans.npmAudit.status === "RESULTS" ? severityText(scans.npmAudit.vulnerabilities) : "NOT_RUN: " + scans.npmAudit.reason),
    "",
    "## Platforms",
    "",
    "Supported: " + (m.supportedPlatforms.length === 0 ? "**none qualified yet**." : m.supportedPlatforms.join(", ") + "."),
    "",
    "| Platform | Gate status | Supported |",
    "| --- | --- | --- |",
    ...m.platforms.map((x) => "| " + x.platform + " | " + x.status + " | " + (x.supported ? "yes" : "NOT_QUALIFIED") + " |"),
    "",
    "## Models",
    "",
    "Runtime: Ollama " + (m.models.runtime.pinnedVersion ?? "unpinned") + " (gate `" + m.models.runtime.gate + "`: " + m.models.runtime.gateStatus + "). Evidence: " + digestText(m.models.evidence),
    "",
    "| Model | Pinned digest | Status |",
    "| --- | --- | --- |",
    ...m.models.entries.map((x) => "| " + x.model + " | " + (x.pinnedDigest ? "`" + x.pinnedDigest + "`" : "none") + " | " + x.status + " |"),
    "",
    "## Six-path capability and live-qualification matrix",
    "",
    "| # | Path | Package scope | Contract admission | Journey (synthetic) | Through cleanup | ACT gate | Live qualification |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...m.paths.map((x) => "| " + x.path + " | " + x.title + " | " + x.packageScope + " | " + x.capability.contractAdmission + " | " + x.capability.journeyStatus + " | " +
      (x.capability.implementedThroughCleanup ? "yes" : "no") + " | " + (x.actGate.id === null ? "NO_GATE" : "`" + x.actGate.id + "` " + x.actGate.status) + " | " + x.liveQualification + " |"),
    "",
    "## Known limitations",
    "",
    ...m.knownLimitations.map((x) => "- `" + x.gate + "` " + x.status + ": " + cell(x.nextAction)),
    "",
    "## Open follow-ups",
    "",
    ...(m.followUps.length === 0 ? ["None."] : m.followUps.map((x) => "- `" + x.id + "` " + x.status + ": " + cell(x.title))),
    "",
    "## Financial boundaries",
    "",
    ...m.boundaries.financial.map((x) => "- " + x),
    "",
    "## Customer-data boundaries",
    "",
    ...m.boundaries.customerData.map((x) => "- " + x),
    "",
    "## Never packaged",
    "",
    ...m.notPackaged.map((x) => "- `" + x.code + "`: " + x.rule),
    "",
  ].join("\n");
}
