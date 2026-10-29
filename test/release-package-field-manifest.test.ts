import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runFieldPackage } from "../src/release/field-package-run.js";
import {
  buildFieldPackage, contractAdmissionOf, FieldPackageRefusal, readRepositoryFacts, renderFieldPackage,
  type FieldPackageInputs, type RepositoryFacts,
} from "../src/release/field-package.js";
import { createReleaseManifest } from "../src/release/manifest.js";
import { REQUIRED_ROWS } from "../src/release/acceptance.js";
import { PRODUCTION_RELEASE_GATES } from "../src/qualification/release-admission.js";
import { promptPolicyHash } from "../src/security/prompt-governance.js";
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
  // The commit is no real candidate, so no gate in the repository's status can pass for it; the pins are those of a release
  // whose owner has recorded no digest yet (config/tool-pins.json today), fixed here so a later pin does not change this test.
  const unpinned = { models: facts.modelPins.models, digests: new Map(facts.modelPins.models.map((model) => [model, null] as [string, null])) };
  const m = build({}, { modelPins: unpinned });
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
  assert.ok(m.models.entries.length > 0 && m.models.entries.every((x) => x.status === "MODEL_DIGEST_UNPINNED" && x.pinnedDigest === null), JSON.stringify(m.models.entries));
  assert.ok(m.paths.every((x) => x.liveQualification !== "LIVE_QUALIFIED"));
  assert.equal(JSON.stringify(m).includes("generatedAt"), false);
  assert.deepEqual(build({}, { modelPins: unpinned }), m, "the same inputs give the same manifest");
  const rendered = renderFieldPackage(m);
  assert.match(rendered, /Supported: \*\*none qualified yet\*\*/);
  assert.match(rendered, /MODEL_DIGEST_UNPINNED/);
  assert.match(rendered, /\*\*ACT:\*\* DISABLED by default/);
});

test("the six-path matrix follows the journey rows, the production contract's pilot pairs and the act gates; GCP API-native is NOT_AVAILABLE", () => {
  const m = build();
  assert.deepEqual(m.paths.map((x) => x.provider + " " + x.engine), REQUIRED_ROWS.map((x) => x.cloud + " " + x.path));
  const by = (provider: string, engine: string) => m.paths.find((x) => x.provider === provider && x.engine === engine)!;
  const native = by("GCP", "GCP_API");
  assert.equal(native.packageScope, "NOT_AVAILABLE");
  assert.equal(native.liveQualification, "NOT_AVAILABLE");
  assert.equal(native.capability.contractAdmission, "NOT_ADMITTED");
  assert.deepEqual(native.actGate, { id: null, status: "NO_GATE" });
  for (const row of m.paths.filter((x) => !(x.provider === "GCP" && x.engine === "GCP_API"))) {
    assert.equal(row.capability.contractAdmission, "ADMITTED", row.title);
    assert.equal(row.packageScope, "DEV_ONLY", row.title);
  }
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

/** A `./alz models verify --production` run of COMMIT on the target host, as the command writes it, passed in every part. */
function verifyRun(pins: Map<string, string | null>, change: Record<string, unknown> = {}, recordChange: Record<string, unknown> = {}) {
  return {
    generatedAt: "2026-10-29T00:00:00.000Z", ollamaBaseUrl: "http://127.0.0.1:11435", policyVersion: "fixture", policyHash: promptPolicyHash(),
    records: [...pins].map(([model, pin]) => ({ model, role: "reasoning", required: true, digest: "sha256:" + (pin ?? "f".repeat(64)), pinnedDigest: pin,
      digestCheck: "PINNED", policyHash: promptPolicyHash(), passed: true, checks: [], ...recordChange })),
    stackChecks: [{ name: "default stack", passed: true }],
    production: { context: { sourceCommit: COMMIT, host: { targetHardwareId: "mbp-01" } }, session: { mutationObserved: false }, checks: [{ name: "restart", passed: true }], passed: true },
    passed: true,
    ...change,
  };
}

test("a model digest is VERIFIED only from a passed --production run of this commit, under this policy, with no synthetic marker, showing the committed pin", () => {
  const D = "e".repeat(64);
  const digests = new Map<string, string | null>([["qwen3:4b", D], ["mistral-nemo:12b", null]]);
  const pins = { models: ["qwen3:4b", "mistral-nemo:12b"], digests };
  const status = (run: unknown) => {
    const m = build({ modelsEvidence: file("verify.json", run) }, { modelPins: pins });
    return m.models.entries.find((x) => x.model === "qwen3:4b")!.status;
  };
  const verified = build({ modelsEvidence: file("verify.json", verifyRun(digests)) }, { modelPins: pins });
  assert.equal(verified.models.entries.find((x) => x.model === "qwen3:4b")!.status, "VERIFIED");
  assert.equal(verified.models.entries.find((x) => x.model === "mistral-nemo:12b")!.status, "MODEL_DIGEST_UNPINNED", "an unpinned model's observed digest is never listed");
  assert.equal(verified.models.entries.find((x) => x.model === "mistral-nemo:12b")!.pinnedDigest, null);
  assert.equal(verified.models.evidence.status, "PRESENT");
  assert.equal(build({}, { modelPins: pins }).models.entries[0].status, "NOT_VERIFIED");

  // Each forgery the review tried, and each condition alone, is refused.
  const ok = verifyRun(digests);
  const forged: [string, unknown][] = [
    ["records only (the review's minimal record)", { records: ok.records }],
    ["top-level fixture", verifyRun(digests, { fixture: true })],
    ["top-level SYNTHETIC evidence mode", verifyRun(digests, { evidenceMode: "SYNTHETIC" })],
    ["a record marked fixture", verifyRun(digests, {}, { fixture: true })],
    ["a record labeled SYNTHETIC", verifyRun(digests, {}, { label: "SYNTHETIC" })],
    ["the run as a whole failed", verifyRun(digests, { passed: false })],
    ["another prompt policy", verifyRun(digests, { policyHash: "0".repeat(64) })],
    ["a record under another prompt policy", verifyRun(digests, {}, { policyHash: "0".repeat(64) })],
    ["not a --production run", verifyRun(digests, { production: undefined })],
    ["another commit", verifyRun(digests, { production: { ...ok.production, context: { ...ok.production.context, sourceCommit: OTHER } } })],
    ["production failed", verifyRun(digests, { production: { ...ok.production, passed: false } })],
    ["a production check failed", verifyRun(digests, { production: { ...ok.production, checks: [{ name: "restart", passed: false }] } })],
    ["a mutation observed", verifyRun(digests, { production: { ...ok.production, session: { mutationObserved: true } } })],
    ["a stack check failed", verifyRun(digests, { stackChecks: [{ name: "default stack", passed: false }] })],
    ["the model's qualification failed", verifyRun(digests, {}, { passed: false })],
    // Admission's PRIVATE_MODEL predicate refuses these too (round-2 review N10).
    ["a top-level mutation observed", verifyRun(digests, { mutationObserved: true })],
    ["live models with synthetic AWS evidence", verifyRun(digests, { mode: "LIVE_LOCAL_MODELS_WITH_SYNTHETIC_AWS_EVIDENCE" })],
    ["no target host", verifyRun(digests, { production: { ...ok.production, context: { sourceCommit: COMMIT } } })],
    ["a production fixture", verifyRun(digests, { production: { ...ok.production, fixture: true } })],
    ["a synthetic flag", verifyRun(digests, { synthetic: true })],
  ];
  for (const [label, run] of forged) assert.equal(status(run), "NOT_VERIFIED", label);
  assert.equal(status(verifyRun(digests, {}, { digest: "sha256:" + "f".repeat(64) })), "MODEL_DIGEST_MISMATCH", "another digest installed");
  assert.equal(status(verifyRun(digests, {}, { digestCheck: "MODEL_DIGEST_UNPINNED" })), "MODEL_DIGEST_MISMATCH", "the run saw no pin");
  assert.equal(status(verifyRun(digests, {}, { pinnedDigest: "f".repeat(64) })), "MODEL_DIGEST_MISMATCH", "the run checked against another pin");
  refusal(() => build({ modelsEvidence: file("verify.json", { nothing: true }) }), "FIELD_MODELS_EVIDENCE_INVALID");
});

/** A gzip ustar archive of the given files, as tar writes one (a ./ prefix on each name). */
function tarGz(entries: [string, Buffer][], type = "0"): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, body] of entries) {
    const header = Buffer.alloc(512);
    header.write("./" + name, 0, 100, "utf8");
    header.write("0000644\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124); header.write("00000000000\0", 136);
    header.write(type, 156); header.write("ustar\0", 257); header.write("00", 263);
    header.fill(" ", 148, 156);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

/** A package of two files with its SBOM and the release manifest that binds them to `commit`. */
function packageFor(commit: string) {
  const sbom = Buffer.from(JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", components: [{}, {}, {}] }));
  const operator = Buffer.from("console.log('operator');\n");
  const manifest = Buffer.from(JSON.stringify(createReleaseManifest({
    productVersion: "0.1.0", sourceCommit: commit, sbomPath: "sbom.cdx.json", sbomSha256: sha256(sbom),
    files: [{ path: "dist/cli/operator.js", sha256: sha256(operator) }, { path: "sbom.cdx.json", sha256: sha256(sbom) }],
  }), null, 2) + "\n");
  const files: [string, Buffer][] = [["dist/cli/operator.js", operator], ["release-manifest.json", manifest], ["sbom.cdx.json", sbom]];
  return { sbom, manifest, files, archive: tarGz(files) };
}
const archiveInput = (bytes: Buffer) => ({ file: "agent-private-landing-zone.tar.gz", bytes });
const checksumOf = (bytes: Buffer, hex = sha256(bytes)) => ({ file: "agent-private-landing-zone.tar.gz.sha256", text: hex + "  .runs/release/agent-private-landing-zone.tar.gz\n" });

test("artifact digests come only from the files given, and the archive is bound file by file to the release manifest of this commit", () => {
  const p = packageFor(COMMIT);
  const inputs = { archive: archiveInput(p.archive), archiveSha256File: checksumOf(p.archive), sbom: { file: "sbom.cdx.json", bytes: p.sbom }, releaseManifest: { file: "release-manifest.json", bytes: p.manifest } };
  const m = build(inputs);
  assert.deepEqual(m.artifacts.archive, { status: "PRESENT", file: "agent-private-landing-zone.tar.gz", sha256: sha256(p.archive) });
  assert.equal(m.artifacts.sbom.status === "PRESENT" && m.artifacts.sbom.sha256, sha256(p.sbom));
  assert.equal(m.artifacts.releaseManifest.status, "PRESENT");
  assert.equal(m.artifacts.runtimeImage.status, "PENDING");
  assert.equal(m.exclusionCheck.status, "PASS");
  assert.match(m.exclusionCheck.scope, /every file in the archive/);
  assert.deepEqual(m.scans.sbom, { status: "PRESENT", format: "CycloneDX", specVersion: "1.5", components: 3 });

  // The review's probe: an unrelated archive with its own checksum, beside this commit's manifest and SBOM.
  const unrelated = tarGz([["notes.txt", Buffer.from("another build")]]);
  refusal(() => build({ ...inputs, archive: archiveInput(unrelated), archiveSha256File: checksumOf(unrelated) }), "FIELD_ARCHIVE_MANIFEST_MISMATCH");
  // Another commit's package, given with this commit's manifest.
  const other = packageFor(OTHER);
  refusal(() => build({ ...inputs, archive: archiveInput(other.archive), archiveSha256File: checksumOf(other.archive) }), "FIELD_ARCHIVE_MANIFEST_MISMATCH");
  // An archive alone is not bound to any commit.
  refusal(() => build({ archive: archiveInput(p.archive) }), "FIELD_ARCHIVE_UNBOUND");
  // A file added to, changed in or missing from the archive.
  refusal(() => build({ ...inputs, archiveSha256File: undefined, archive: archiveInput(tarGz([...p.files, ["config/act-pilot-contract.json", Buffer.from("{}")]])) }), "FIELD_ARCHIVE_UNLISTED_FILE");
  refusal(() => build({ ...inputs, archiveSha256File: undefined, archive: archiveInput(tarGz(p.files.map(([n, b]) => [n, n === "dist/cli/operator.js" ? Buffer.from("changed") : b]))) }), "FIELD_ARCHIVE_CONTENT_MISMATCH");
  refusal(() => build({ ...inputs, archiveSha256File: undefined, archive: archiveInput(tarGz(p.files.filter(([n]) => n !== "dist/cli/operator.js"))) }), "FIELD_ARCHIVE_CONTENT_MISMATCH");
  refusal(() => build({ ...inputs, archiveSha256File: undefined, archive: archiveInput(tarGz([["link", Buffer.alloc(0)]], "2")) }), "FIELD_ARCHIVE_UNREADABLE");
  refusal(() => build({ ...inputs, archiveSha256File: undefined, archive: archiveInput(Buffer.from("not an archive")) }), "FIELD_ARCHIVE_UNREADABLE");
  // An earlier, shadowed copy of a listed name carrying other content (round-2 review N9).
  refusal(() => build({ ...inputs, archiveSha256File: undefined, archive: archiveInput(tarGz([["dist/cli/operator.js", Buffer.from(JSON.stringify({ enabled: true, provider: "AWS", engine: "TERRAFORM", targets: {}, authorize: { DEV: ["APPLY"] } }))], ...p.files])) }), "FIELD_ARCHIVE_UNREADABLE");

  refusal(() => build({ ...inputs, archiveSha256File: checksumOf(p.archive, "1".repeat(64)) }), "FIELD_ARCHIVE_CHECKSUM_MISMATCH");
  refusal(() => build({ archiveSha256File: checksumOf(p.archive) }), "FIELD_ARCHIVE_MISSING");
  refusal(() => build({ releaseManifest: { file: "release-manifest.json", bytes: packageFor(OTHER).manifest } }), "FIELD_RELEASE_MANIFEST_COMMIT_MISMATCH");
  const parsed = JSON.parse(p.manifest.toString("utf8"));
  refusal(() => build({ releaseManifest: file("release-manifest.json", { ...parsed, contract: { ...parsed.contract, actEnabled: true } }) }), "FIELD_RELEASE_MANIFEST_INVALID");
  refusal(() => build({ releaseManifest: file("release-manifest.json", { ...parsed, files: [...parsed.files, { path: "config/act-pilot-contract.json", sha256: "0".repeat(64) }] }) }), "FIELD_PACKAGE_EXCLUDED_CONTENT");
  refusal(() => build({ sbom: file("sbom.cdx.json", { bomFormat: "CycloneDX", components: [] }), releaseManifest: inputs.releaseManifest }), "FIELD_SBOM_MISMATCH");
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
