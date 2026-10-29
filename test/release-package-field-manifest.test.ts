import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runFieldPackage } from "../src/cli/field-package.js";
import {
  buildFieldPackage, contractAdmissionOf, FieldPackageRefusal, readRepositoryFacts, renderFieldPackage,
  type FieldPackageInputs, type RepositoryFacts,
} from "../src/release/field-package.js";
import { createReleaseManifest } from "../src/release/manifest.js";
import { REQUIRED_ROWS } from "../src/release/acceptance.js";
import { PRODUCTION_RELEASE_GATES } from "../src/qualification/release-admission.js";
import { sha256 } from "../src/util/sha256.js";

// The field package manifest generator (docs/field-package.md). SYNTHETIC: every artifact, scan, model record and gate
// status below is a fixture; none is evidence of a real build, host, model or cloud.

const repository = fileURLToPath(new URL("../", import.meta.url));
const COMMIT = "c".repeat(40);
const OTHER = "d".repeat(40);
const facts = readRepositoryFacts(repository);
const file = (name: string, value: unknown) => ({ file: name, bytes: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)) });
const refusal = (fn: () => unknown, code: string) => assert.throws(fn, (e: unknown) => e instanceof FieldPackageRefusal && e.code === code, code);
const build = (inputs: Partial<FieldPackageInputs> = {}, over: Partial<RepositoryFacts> = {}) =>
  buildFieldPackage({ sourceCommit: COMMIT, ...inputs }, { ...facts, ...over });
/** The repository's status with one gate replaced, for the "only as evidenced" rules. */
const withGate = (gate: string, change: Record<string, unknown>): Partial<RepositoryFacts> =>
  ({ status: { ...facts.status, gates: facts.status.gates.map((x) => x.gate === gate ? { ...x, ...change } : x) } });

test("with no inputs, nothing is claimed: artifacts PENDING, scans NOT_RUN, no platform, no model digest, no live path; ACT DISABLED", () => {
  const m = build();
  assert.equal(m.kind, "SUPERVISED_DEV_ACT_PILOT");
  assert.match(m.statement, /not a production deployment product/);
  assert.deepEqual(m.act, { ...m.act, defaultInstallation: "DISABLED", packagedContract: "NONE" });
  assert.equal(m.source.acceptance, "PENDING_OWNER");
  for (const artifact of Object.values(m.artifacts)) assert.equal(artifact.status, "PENDING");
  assert.equal(m.exclusionCheck.status, "PENDING");
  for (const scan of Object.values(m.scans)) assert.equal(scan.status, "NOT_RUN");
  assert.equal(m.models.evidence.status, "NOT_RUN");
  assert.deepEqual(m.supportedPlatforms, []);
  assert.ok(m.platforms.every((x) => !x.supported));
  // The repository pins no model digest yet (config/tool-pins.json, owner input), so none is listed.
  assert.ok(m.models.entries.every((x) => x.status === "MODEL_DIGEST_UNPINNED" && x.pinnedDigest === null), JSON.stringify(m.models.entries));
  assert.ok(m.paths.every((x) => x.liveQualification !== "LIVE_QUALIFIED"));
  assert.equal(JSON.stringify(m).includes("generatedAt"), false);
  assert.deepEqual(build(), m, "the same inputs give the same manifest");
  const rendered = renderFieldPackage(m);
  assert.match(rendered, /Supported: \*\*none qualified yet\*\*/);
  assert.match(rendered, /MODEL_DIGEST_UNPINNED/);
  assert.match(rendered, /\*\*ACT:\*\* DISABLED by default/);
});

test("the six-path matrix follows the journey rows, the product's contract admission and the act gates; GCP API-native is NOT_AVAILABLE", () => {
  const m = build();
  assert.deepEqual(m.paths.map((x) => x.provider + " " + x.engine), REQUIRED_ROWS.map((x) => x.cloud + " " + x.path));
  const by = (provider: string, engine: string) => m.paths.find((x) => x.provider === provider && x.engine === engine)!;
  const native = by("GCP", "GCP_API");
  assert.equal(native.packageScope, "NOT_AVAILABLE");
  assert.equal(native.liveQualification, "NOT_AVAILABLE");
  assert.equal(native.capability.contractAdmission, "NOT_IMPLEMENTED");
  assert.deepEqual(native.actGate, { id: null, status: "NO_GATE" });
  assert.equal(by("AZURE", "BICEP").capability.contractAdmission, "DEV_ONLY_REQUIRED");
  assert.equal(by("GCP", "TERRAFORM").capability.contractAdmission, "DEV_ONLY_REQUIRED");
  for (const row of m.paths.filter((x) => x.packageScope === "DEV_ONLY")) {
    assert.ok(row.actGate.id !== null && PRODUCTION_RELEASE_GATES.some((g) => g.id === row.actGate.id), row.title + " names its release gate");
    assert.equal(row.liveQualification, "NOT_QUALIFIED");
  }
  assert.equal(contractAdmissionOf("ORACLE", "TERRAFORM"), "NOT_ADMITTED");
  assert.equal(contractAdmissionOf("AZURE", "CDK"), "NOT_ADMITTED");
});

test("a path is live-qualified only with its act gate PASS for this commit on LIVE evidence and its journey row LIVE_PASS", () => {
  const live = facts.journeys.map((x) => x.cloud === "AWS" && x.path === "TERRAFORM" ? { ...x, live: "LIVE_PASS" as const } : x);
  const aws = (m: ReturnType<typeof build>) => m.paths.find((x) => x.provider === "AWS" && x.engine === "TERRAFORM")!.liveQualification;
  const pass = { status: "PASS", evidenceMode: "LIVE", candidate: COMMIT, evidenceRefs: ["fixture"] };
  assert.equal(aws(build({}, { ...withGate("act:aws-terraform", pass) })), "NOT_QUALIFIED", "gate alone");
  assert.equal(aws(build({}, { journeys: live })), "NOT_QUALIFIED", "journey alone");
  assert.equal(aws(build({}, { ...withGate("act:aws-terraform", { ...pass, candidate: OTHER }), journeys: live })), "NOT_QUALIFIED", "another commit");
  assert.equal(aws(build({}, { ...withGate("act:aws-terraform", { ...pass, evidenceMode: "SYNTHETIC" }), journeys: live })), "NOT_QUALIFIED", "synthetic");
  assert.equal(aws(build({}, { ...withGate("act:aws-terraform", pass), journeys: live })), "LIVE_QUALIFIED");
});

test("a platform is supported only when its gate passed for this commit on LIVE evidence", () => {
  const pass = { status: "PASS", evidenceMode: "LIVE", candidate: COMMIT, evidenceRefs: ["fixture"] };
  assert.deepEqual(build({}, withGate("platform:linux-x64", { ...pass, candidate: OTHER })).supportedPlatforms, []);
  assert.deepEqual(build({}, withGate("platform:linux-x64", { ...pass, evidenceMode: "SYNTHETIC" })).supportedPlatforms, []);
  assert.deepEqual(build({}, withGate("platform:linux-x64", { ...pass, status: "RUNNING" })).supportedPlatforms, []);
  assert.deepEqual(build({}, withGate("platform:linux-x64", pass)).supportedPlatforms, ["linux-x64"]);
});

test("a model digest is listed as verified only when it is the committed pin and ./alz models verify shows it installed and qualified", () => {
  const D = "e".repeat(64);
  const pins = { models: ["qwen3:4b", "mistral-nemo:12b"], digests: new Map<string, string | null>([["qwen3:4b", D], ["mistral-nemo:12b", null]]) };
  const evidence = (records: unknown[]) => ({ modelsEvidence: file("verify.json", { records }) });
  const status = (m: ReturnType<typeof build>, model: string) => m.models.entries.find((x) => x.model === model)!.status;
  const ok = { model: "qwen3:4b", digest: "sha256:" + D, digestCheck: "PINNED", passed: true };
  const verified = build(evidence([ok, { model: "mistral-nemo:12b", digest: "f".repeat(64), digestCheck: "PINNED", passed: true }]), { modelPins: pins });
  assert.equal(status(verified, "qwen3:4b"), "VERIFIED");
  assert.equal(status(verified, "mistral-nemo:12b"), "MODEL_DIGEST_UNPINNED", "an unpinned model's observed digest is never listed");
  assert.equal(verified.models.entries.find((x) => x.model === "mistral-nemo:12b")!.pinnedDigest, null);
  assert.equal(verified.models.evidence.status, "PRESENT");
  assert.equal(status(build({}, { modelPins: pins }), "qwen3:4b"), "NOT_VERIFIED");
  assert.equal(status(build(evidence([{ ...ok, digest: "f".repeat(64) }]), { modelPins: pins }), "qwen3:4b"), "MODEL_DIGEST_MISMATCH");
  assert.equal(status(build(evidence([{ ...ok, digestCheck: "MODEL_DIGEST_UNPINNED" }]), { modelPins: pins }), "qwen3:4b"), "MODEL_DIGEST_MISMATCH");
  assert.equal(status(build(evidence([{ ...ok, passed: false }]), { modelPins: pins }), "qwen3:4b"), "NOT_VERIFIED");
  refusal(() => build({ modelsEvidence: file("verify.json", { nothing: true }) }), "FIELD_MODELS_EVIDENCE_INVALID");
});

function releaseManifest(commit: string, sbomBytes: Buffer, paths: string[] = ["dist/cli/operator.js"]) {
  return createReleaseManifest({
    productVersion: "0.1.0", sourceCommit: commit, sbomPath: "sbom.cdx.json", sbomSha256: sha256(sbomBytes),
    files: [...paths.map((path) => ({ path, sha256: "0".repeat(64) })), { path: "sbom.cdx.json", sha256: sha256(sbomBytes) }],
  });
}

test("artifact digests come only from the files given, cross-checked against each other and the commit", () => {
  const sbomBytes = Buffer.from(JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", components: [{}, {}, {}] }));
  const sbom = { file: "sbom.cdx.json", bytes: sbomBytes };
  const archive = { file: "agent-private-landing-zone.tar.gz", bytes: Buffer.from("synthetic archive bytes") };
  const checksum = (hex: string) => ({ file: "agent-private-landing-zone.tar.gz.sha256", text: hex + "  .runs/release/agent-private-landing-zone.tar.gz\n" });

  const m = build({ archive, archiveSha256File: checksum(sha256(archive.bytes)), sbom, releaseManifest: file("release-manifest.json", releaseManifest(COMMIT, sbomBytes)) });
  assert.deepEqual(m.artifacts.archive, { status: "PRESENT", file: archive.file, sha256: sha256(archive.bytes) });
  assert.equal(m.artifacts.sbom.status === "PRESENT" && m.artifacts.sbom.sha256, sha256(sbomBytes));
  assert.equal(m.artifacts.releaseManifest.status, "PRESENT");
  assert.equal(m.artifacts.runtimeImage.status, "PENDING");
  assert.equal(m.exclusionCheck.status, "PASS");
  assert.deepEqual(m.scans.sbom, { status: "PRESENT", format: "CycloneDX", specVersion: "1.5", components: 3 });

  refusal(() => build({ archive, archiveSha256File: checksum("1".repeat(64)) }), "FIELD_ARCHIVE_CHECKSUM_MISMATCH");
  refusal(() => build({ archiveSha256File: checksum(sha256(archive.bytes)) }), "FIELD_ARCHIVE_MISSING");
  refusal(() => build({ releaseManifest: file("release-manifest.json", releaseManifest(OTHER, sbomBytes)) }), "FIELD_RELEASE_MANIFEST_COMMIT_MISMATCH");
  refusal(() => build({ releaseManifest: file("release-manifest.json", { ...releaseManifest(COMMIT, sbomBytes), contract: { id: "x", version: "1", operatingMode: "PREVIEW_OPERATE", actEnabled: true } }) }), "FIELD_RELEASE_MANIFEST_INVALID");
  refusal(() => build({ releaseManifest: file("release-manifest.json", releaseManifest(COMMIT, sbomBytes, ["config/act-pilot-contract.json"])) }), "FIELD_PACKAGE_EXCLUDED_CONTENT");
  refusal(() => build({ sbom: file("sbom.cdx.json", { bomFormat: "CycloneDX", components: [] }), releaseManifest: file("release-manifest.json", releaseManifest(COMMIT, sbomBytes)) }), "FIELD_SBOM_MISMATCH");
  refusal(() => build({ sbom: file("sbom.cdx.json", { bomFormat: "SPDX" }) }), "FIELD_SBOM_INVALID");
  refusal(() => build({ sourceCommit: "60f017e" }), "FIELD_SOURCE_COMMIT_INVALID");
});

test("scan results are summarized from the scanners' own output, and anything else is refused", () => {
  const trivy = file("trivy-results.json", {
    ArtifactName: ".", ArtifactType: "filesystem",
    Results: [{ Target: "package-lock.json", Vulnerabilities: [{ Severity: "HIGH" }, { Severity: "CRITICAL" }, { Severity: "HIGH" }] }, { Target: "Dockerfile", Misconfigurations: [{ Severity: "HIGH" }] }],
  });
  const audit = file("audit.json", { auditReportVersion: 2, metadata: { vulnerabilities: { info: 0, low: 1, moderate: 0, high: 0, critical: 0, total: 1 } } });
  const m = build({ trivy, npmAudit: audit });
  assert.equal(m.scans.trivy.status, "RESULTS");
  if (m.scans.trivy.status === "RESULTS") {
    assert.deepEqual(m.scans.trivy.vulnerabilities, { CRITICAL: 1, HIGH: 2 });
    assert.deepEqual(m.scans.trivy.misconfigurations, { HIGH: 1 });
    assert.equal(m.scans.trivy.targets, 2);
    assert.equal(m.scans.trivy.sha256, sha256(trivy.bytes));
  }
  assert.deepEqual(m.scans.npmAudit.status === "RESULTS" && m.scans.npmAudit.vulnerabilities, { info: 0, low: 1, moderate: 0, high: 0, critical: 0, total: 1 });
  refusal(() => build({ trivy: file("trivy.json", { results: [] }) }), "FIELD_TRIVY_INVALID");
  refusal(() => build({ trivy: file("trivy.json", "not json") }), "FIELD_TRIVY_INVALID");
  refusal(() => build({ npmAudit: file("audit.json", { metadata: { vulnerabilities: { high: -1 } } }) }), "FIELD_AUDIT_INVALID");
});

test("locks, pins, limitations and boundaries are read from the repository, never typed", () => {
  const m = build();
  const lock = m.dependencyLocks.find((x) => x.file === "package-lock.json");
  assert.equal(lock?.sha256, sha256(readFileSync(join(repository, "package-lock.json"))));
  // Every canary lock under qualification/ is listed with its own hash. (The ARM64 test image has no qualification/ folder,
  // so the independent walk below finds what the generator must find on either host.)
  const expected: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(join(repository, dir))) return;
    for (const entry of readdirSync(join(repository, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) { if (entry.name !== "node_modules" && entry.name !== ".terraform") walk(dir + "/" + entry.name); }
      else if (entry.name === ".terraform.lock.hcl" || entry.name === "package-lock.json") expected.push(dir + "/" + entry.name);
    }
  };
  walk("qualification");
  assert.deepEqual(m.dependencyLocks.map((x) => x.file).slice(1).sort(), expected.sort());
  for (const entry of m.dependencyLocks) assert.equal(entry.sha256, sha256(readFileSync(join(repository, entry.file))), entry.file);
  // Provider pins are read from the lock text.
  const hcl = 'provider "registry.terraform.io/hashicorp/aws" {\n  version     = "6.68.0"\n  constraints = "6.68.0"\n  hashes = [\n    "h1:x",\n  ]\n}\n';
  const pinned = build({}, { locks: [{ file: "qualification/x/.terraform.lock.hcl", bytes: Buffer.from(hcl) }] });
  assert.deepEqual(pinned.dependencyLocks, [{ file: "qualification/x/.terraform.lock.hcl", sha256: sha256(Buffer.from(hcl)), kind: "terraform", providers: [{ source: "registry.terraform.io/hashicorp/aws", version: "6.68.0" }] }]);
  assert.equal(m.toolPins.sha256, sha256(readFileSync(join(repository, "config/tool-pins.json"))));
  assert.ok(m.toolPins.tools.some((t) => t.tool === "terraform"));
  const inScope = facts.status.gates.filter((x) => x.status !== "PASS" && !facts.scope.outOfScope.some((o) => o.gate === x.gate));
  assert.deepEqual(m.knownLimitations.map((x) => x.gate), inScope.map((x) => x.gate));
  assert.ok(m.followUps.every((x) => x.status !== "DONE"));
  assert.ok(m.boundaries.financial.some((x) => /authorizes no spending/.test(x)));
  assert.ok(m.boundaries.customerData.some((x) => /Redact/.test(x)));
  assert.ok(m.notPackaged.some((x) => x.code === "PILOT_CONTRACT") && m.notPackaged.some((x) => x.code === "RUNNER_REGISTRATION"));
  refusal(() => build({}, { journeyProblems: ["AWS TERRAFORM execute: a cited test is missing"] }), "FIELD_JOURNEY_MATRIX_INVALID");
});

test("the generator refuses a checkout that is not the named commit and writes nothing; otherwise it writes the JSON and its rendering", () => {
  const out = mkdtempSync(join(tmpdir(), "alz-field-"));
  const lines: string[] = [];
  const deps = (commit: string | undefined) => ({
    sourceOf: () => commit === undefined ? { ok: false as const, reason: "The checkout has uncommitted changes." } : { ok: true as const, commit, origin: "GIT_CHECKOUT" as const },
    factsOf: () => facts, log: (l: string) => lines.push(l), error: (l: string) => lines.push(l),
  });
  try {
    const dir = join(out, "a");
    assert.equal(runFieldPackage(["--source-commit", COMMIT, "--out", dir, "--root", repository], deps(OTHER)), 1);
    assert.match(lines.join("\n"), /FIELD_SOURCE_COMMIT_MISMATCH/);
    assert.equal(runFieldPackage(["--source-commit", COMMIT, "--out", dir, "--root", repository], deps(undefined)), 1);
    assert.match(lines.join("\n"), /FIELD_SOURCE_UNVERIFIED/);
    assert.equal(runFieldPackage(["--out", dir], deps(COMMIT)), 1);
    assert.equal(runFieldPackage(["--source-commit", COMMIT, "--out", dir, "--image-digest", "sha256:" + "a".repeat(64)], deps(COMMIT)), 1, "a digest is never typed");
    assert.match(lines.join("\n"), /unknown argument --image-digest/);
    assert.equal(existsSync(dir), false);

    assert.equal(runFieldPackage(["--source-commit", COMMIT, "--out", dir, "--root", repository], deps(COMMIT)), 0, lines.join("\n"));
    const written = JSON.parse(readFileSync(join(dir, "field-package.json"), "utf8"));
    assert.deepEqual(written, build());
    assert.equal(readFileSync(join(dir, "field-package.md"), "utf8"), renderFieldPackage(build()));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
