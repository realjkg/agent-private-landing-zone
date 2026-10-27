import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadPilotContract, pilotContractSha256 } from "../src/apply/contract.js";
import { APPLY_AUTHORITY } from "../src/apply/evidence.js";
import { buildRecoveryEvidence } from "../src/apply/recovery-record.js";
import type { ApplyEvidence, PilotContract } from "../src/apply/types.js";
import { awsContractJson } from "./helpers/apply-fixtures.js";
import {
  PRODUCTION_RELEASE_GATES,
  reviewProductionRelease,
  type ReleaseAdmissionInput,
  type ReleaseGateSubmission,
} from "../src/qualification/release-admission.js";

const commit = "a".repeat(40);
const target = "private-lab-host-01";
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function input(records: ReleaseGateSubmission[]): ReleaseAdmissionInput {
  return {
    schemaVersion: 1, sourceCommit: commit,
    operatingMode: "PREVIEW_OPERATE", infrastructureAct: "DISABLED",
    records,
  };
}
function harness() {
  const root = mkdtempSync(join(tmpdir(), "alz-release-admission-"));
  const attach = (
    id: string,
    mode: ReleaseGateSubmission["mode"],
    payload: object,
  ): ReleaseGateSubmission => {
    const name = id.replaceAll(":", "-") + ".json";
    const bytes = JSON.stringify(payload) + "\n";
    mkdirSync(join(root, "evidence"), { recursive: true });
    writeFileSync(join(root, "evidence", name), bytes);
    return { id, mode, sourceCommit: commit, targetHardwareId: target,
      evidencePath: "evidence/" + name, evidenceSha256: hash(bytes) };
  };
  return { root, attach, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function generic(gateId: string, mode: string): object {
  return {
    schemaVersion: 1, gateId, executionMode: mode,
    sourceCommit: commit, targetHardwareId: target,
    passed: true, actEnabled: false, mutationObserved: false,
    checks: [{ name: "actual target evidence", passed: true,
      evidenceSha256: "b".repeat(64) }],
  };
}
test("release gate registry covers actual AWS, Azure, Pulumi and production obligations", () => {
  const keys = PRODUCTION_RELEASE_GATES.map((x) => x.id);
  assert.equal(new Set(keys).size, keys.length);
  for (const id of [
    "source-ci", "release-archive", "arm64-final-image",
    "private-model-runtime", "aws-provider", "azure-provider",
    "preview:terraform-aws-brownfield", "preview:pulumi-azure-greenfield",
    "preview:pulumi-aws-greenfield", "preview:pulumi-aws-brownfield",
    "preview:pulumi-azure-brownfield", "isolated-recovery",
    "lifecycle:rollback", "lifecycle:configuration-migration",
    "pillar:cost", "pillar:performance", "pillar:sustainability",
    "pillar:security", "pillar:operational-excellence",
    "platform:darwin-arm64", "platform:darwin-x64", "platform:linux-x64", "platform:linux-arm64", "platform:win32-arm64", "platform:win32-x64",
    "act:aws-terraform", "act:azure-terraform", "act:aws-cdk", "act-run-recovery", "security-review:independent",
    "preview:terraform-azure-brownfield",
  ]) assert.ok(keys.includes(id), id);
});

test("empty manifest is BLOCKED; no missing evidence can imply release approval", async () => {
  const h = harness();
  try {
    const review = await reviewProductionRelease({
      manifest: input([]), expectedCommit: commit, root: h.root,
    });
    assert.equal(review.readyForIndependentReleaseReview, false);
    assert.equal(review.productionReleaseApproved, false);
    assert.equal(review.infrastructureAct, "DISABLED");
    assert.equal(review.gates.length, PRODUCTION_RELEASE_GATES.length);
    assert.ok(review.gates.every((g) => g.status === "BLOCKED"));
    assert.ok(review.blockers.some((m) => m.includes("private-model-runtime")));
    assert.ok(review.blockers.some((m) => m.includes("azure-provider")));
  } finally { h.cleanup(); }
});

test("one authentic structurally valid CI record only satisfies its own gate", async () => {
  const h = harness();
  try {
    const report = generic("source-ci", "CI");
    const attached = h.attach("source-ci", "CI", report);
    const review = await reviewProductionRelease({
      manifest: input([attached]), expectedCommit: commit, root: h.root,
    });
    assert.equal(review.gates.find((g) => g.id === "source-ci")?.status,
      "EVIDENCE_PRESENT");
    assert.equal(review.gates.find((g) => g.id === "private-model-runtime")?.status,
      "BLOCKED");
    assert.equal(review.readyForIndependentReleaseReview, false);
    assert.equal(review.productionReleaseApproved, false);
  } finally { h.cleanup(); }
});

test("wrong source, digest, duplicate, unknown gate and path traversal fail closed", async () => {
  const h = harness();
  try {
    const attached = h.attach("source-ci", "CI", generic("source-ci", "CI"));
    for (const records of [
      [{ ...attached, sourceCommit: "c".repeat(40) }],
      [{ ...attached, evidenceSha256: "d".repeat(64) }],
      [{ ...attached, evidencePath: "../outside.json" }],
      [attached, attached],
      [attached, { ...attached, id: "unregistered-test" }],
    ]) {
      const review = await reviewProductionRelease({
        manifest: input(records), expectedCommit: commit, root: h.root,
      });
      assert.equal(review.readyForIndependentReleaseReview, false);
      assert.ok(review.blockers.length > 0);
    }
    const mismatch = await reviewProductionRelease({
      manifest: input([attached]), expectedCommit: "f".repeat(40), root: h.root,
    });
    assert.equal(mismatch.readyForIndependentReleaseReview, false);
  } finally { h.cleanup(); }
});

test("synthetic model-generated Terraform does not pass live preview gate", async () => {
  const h = harness();
  try {
    const id = "preview:terraform-aws-brownfield";
    const wrong = h.attach(id, "LIVE_PREVIEW", {
      ...generic(id, "LIVE_PREVIEW"),
      mode: "LIVE_LOCAL_MODELS_WITH_SYNTHETIC_AWS_EVIDENCE",
      simulation: true, previewExecuted: true,
      toolOutputHash: "e".repeat(64),
      infrastructureApplied: false,
    });
    const review = await reviewProductionRelease({
      manifest: input([wrong]), expectedCommit: commit, root: h.root,
    });
    assert.equal(review.gates.find((g) => g.id === id)?.status, "BLOCKED");
  } finally { h.cleanup(); }
});

test("existing target model qualification report is recognized only when source, host, three digests and restart checks match", async () => {
  const h = harness();
  try {
    const id = "private-model-runtime";
    const records = ["qwen3:1.7b", "qwen3:4b", "mistral-nemo:latest"].map(
      (model) => ({ model, digest: "b".repeat(64), passed: true }));
    const value = {
      records,
      stackChecks: [{ name: "independent consensus", passed: true }],
      production: {
        passed: true,
        context: { sourceCommit: commit,
          host: { targetHardwareId: target } },
        session: { mutationObserved: false },
        checks: [{ name: "checkpoint restart", passed: true }],
      },
      passed: true,
    };
    const attached = h.attach(id, "PRIVATE_MODEL", value);
    const review = await reviewProductionRelease({
      manifest: input([attached]), expectedCommit: commit, root: h.root,
    });
    assert.equal(review.gates.find((g) => g.id === id)?.status, "EVIDENCE_PRESENT");
    const bad = h.attach(id, "PRIVATE_MODEL", {
      ...value, production: { ...value.production,
        context: { sourceCommit: commit, host: { targetHardwareId: "OTHER" } } },
    });
    const rejection = await reviewProductionRelease({
      manifest: input([bad]), expectedCommit: commit, root: h.root,
    });
    assert.equal(rejection.gates.find((g) => g.id === id)?.status, "BLOCKED");
  } finally { h.cleanup(); }
});

test("live provider report must be real and source-bound, not synthetic discovery", async () => {
  const h = harness();
  try {
    const id = "azure-provider";
    const evidence = {
      schemaVersion: 1, sourceCommit: commit, provider: "AZURE",
      ready: true, actEnabled: false, blockers: [],
      discovery: { evidenceSources: ["azure-cli"], snapshotSha256: "d".repeat(64) },
      validation: { passed: true },
      preview: { outputSha256: "e".repeat(64) },
    };
    const good = h.attach(id, "LIVE_PROVIDER", evidence);
    const valid = await reviewProductionRelease({
      manifest: input([good]), expectedCommit: commit, root: h.root,
    });
    assert.equal(valid.gates.find((g) => g.id === id)?.status, "EVIDENCE_PRESENT");
    const fake = h.attach(id, "LIVE_PROVIDER", {
      ...evidence, discovery: {
        ...evidence.discovery, evidenceSources: ["mock"],
      },
    });
    const invalid = await reviewProductionRelease({
      manifest: input([fake]), expectedCommit: commit, root: h.root,
    });
    assert.equal(invalid.gates.find((g) => g.id === id)?.status, "BLOCKED");
  } finally { h.cleanup(); }
});

test("real recovery requires observed times and restore; scanner requires zero blocking findings", async () => {
  const h = harness();
  try {
    const recoveryId = "isolated-recovery";
    const scanId = "arm64-final-image";
    const attempted = h.attach(recoveryId, "ISOLATED_RECOVERY", {
      ...generic(recoveryId, "ISOLATED_RECOVERY"),
      restoreExecuted: false, observedRpoSeconds: 0, observedRtoSeconds: 0,
    });
    const scan = h.attach(scanId, "SECURITY_SCAN", {
      ...generic(scanId, "SECURITY_SCAN"),
      imageDigest: "sha256:" + "f".repeat(64),
      criticalFindings: 4, highFindings: 60,
    });
    const report = await reviewProductionRelease({
      manifest: input([attempted, scan]), expectedCommit: commit, root: h.root,
    });
    assert.equal(report.gates.find((g) => g.id === recoveryId)?.status, "BLOCKED");
    assert.equal(report.gates.find((g) => g.id === scanId)?.status, "BLOCKED");
  } finally { h.cleanup(); }
});

// docs/act-pilot-plan.md, G3. A pilot-scoped ACT setting is representable, and
// nothing else is: ACT stays DISABLED globally, and a release may declare PILOT
// only together with a valid, enabled pilot contract that it names by hash.
const pilotRoot = mkdtempSync(join(tmpdir(), "alz-release-pilot-"));
test.after(() => rmSync(pilotRoot, { recursive: true, force: true }));
const contractPath = join(pilotRoot, "act-pilot-contract.json");
const pinPath = join(pilotRoot, "act-pilot-contract.sha256");
const publicKey = () => generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
const approvers = [1, 2].map((n) => ({ id: "approver-" + n, publicKeyPem: publicKey(), environments: ["DEV", "QA", "PROD"] }));
const loadPinned = (path: string = contractPath) => loadPilotContract(path, pinPath);
const pilotTarget = (n: string, store: string) => ({ tenantId: "11111111-1111-4111-8111-111111111111",
  subscriptionId: n.repeat(8) + "-" + n.repeat(4) + "-4" + n.repeat(3) + "-8" + n.repeat(3) + "-" + n.repeat(12),
  backend: store + "/tfstate/x.tfstate", workspace: "default" });
const contractJson = (enabled: boolean, age = 60) => ({
  schemaVersion: 1, enabled, provider: "AZURE", engine: "TERRAFORM",
  targets: { DEV: pilotTarget("2", "fixturedevstore"), QA: pilotTarget("4", "fixtureqastore"), PROD: pilotTarget("3", "fixtureprodstore") },
  requiredApprovals: { DEV: 1, QA: 1, PROD: 2 }, maxApprovalAgeMinutes: age, approvers, killSwitchPath: join(pilotRoot, "KILL"),
});
/** Writes the contract and, like a reviewed commit, its pin. */
const writeContract = (enabled: boolean, age = 60) => {
  writeFileSync(contractPath, JSON.stringify(contractJson(enabled, age)));
  writeFileSync(pinPath, pilotContractSha256(contractJson(true, age) as unknown as PilotContract) + "\n");
};
const pilotInput = (actPilot: unknown, infrastructureAct: string = "PILOT") =>
  ({ ...input([]), infrastructureAct, ...(actPilot === undefined ? {} : { actPilot }) }) as unknown as ReleaseAdmissionInput;
const review = (manifest: ReleaseAdmissionInput, pilotContract?: ReturnType<typeof loadPilotContract>) =>
  reviewProductionRelease({ manifest, expectedCommit: commit, root: pilotRoot, pilotContract, pilotPinPath: pinPath });
const actBlockers = (r: { blockers: string[] }) => r.blockers.filter((b) => /^ACT_PILOT|^RELEASE_MANIFEST/.test(b));

test("under a PILOT release a live ACT record and a recovery record must name the pinned contract, and the recovery record the approval count that contract requires for its environment (#269 review N2); a release with no pilot scope binds neither", async () => {
  writeContract(true);
  const pinned = loadPinned() as PilotContract;
  const scope = { provider: "AZURE", engine: "TERRAFORM", contractSha256: pilotContractSha256(pinned) };
  const attach = (id: string, mode: ReleaseGateSubmission["mode"], payload: object): ReleaseGateSubmission => {
    const name = id.replaceAll(":", "-") + "-" + hash(JSON.stringify(payload)).slice(0, 8) + ".json";
    const bytes = JSON.stringify(payload) + "\n";
    mkdirSync(join(pilotRoot, "evidence"), { recursive: true });
    writeFileSync(join(pilotRoot, "evidence", name), bytes);
    return { id, mode, sourceCommit: commit, targetHardwareId: target, evidencePath: "evidence/" + name, evidenceSha256: hash(bytes) };
  };
  const status = async (id: string, mode: ReleaseGateSubmission["mode"], payload: object, manifest: ReleaseAdmissionInput = { ...pilotInput(scope), records: [attach(id, mode, payload)] }) =>
    (await review({ ...manifest, records: manifest.records.length > 0 ? manifest.records : [attach(id, mode, payload)] }, pinned)).gates.find((g) => g.id === id)?.status;
  // The live ACT record: the pinned contract's hash is admitted, another contract's is not.
  const live = {
    schemaVersion: 1, label: "LIVE", step: "execute", cloud: "AZURE", engine: "TERRAFORM", environment: "DEV", target: { account: "a", backend: "b", workspace: "default" },
    sourceCommit: commit, artifactSha256: "1".repeat(64), outcome: "SUCCEEDED", evidenceSha256: "2".repeat(64), contractSha256: scope.contractSha256, attestedBy: "owner", attestedAt: "2026-10-25T00:00:00.000Z",
  };
  assert.equal(await status("act:azure-terraform", "LIVE_ACT", live), "EVIDENCE_PRESENT");
  assert.equal(await status("act:azure-terraform", "LIVE_ACT", { ...live, contractSha256: "3".repeat(64) }), "BLOCKED", "another contract");
  // The recovery record, built by the producer under the pinned contract: DEV with the one approval the contract requires is admitted.
  const at = (minutes: number): string => new Date(Date.UTC(2026, 9, 12, 12, minutes)).toISOString();
  const apply = (over: Partial<ApplyEvidence>): ApplyEvidence => ({
    schemaVersion: 1, environment: "DEV", target: { account: "a", backend: "b", workspace: "default" }, artifactSha256: "5".repeat(64), manifestHash: "2".repeat(64), releaseIdentity: "3".repeat(64),
    contractSha256: scope.contractSha256, sourceCommit: commit, approvals: [{ approverId: "approver-1", issuedAt: at(-30) }], adapter: { adapterVersion: "a", argvDigest: "4".repeat(64) },
    toolVersions: { engine: "1.9.5" }, outcome: "SUCCEEDED", exitCode: 0, startedAt: at(-10), finishedAt: at(0), authority: APPLY_AUTHORITY, ...over,
  });
  const built = buildRecoveryEvidence({
    interrupted: apply({ outcome: "KILLED", exitCode: null }), resumed: apply({ artifactSha256: "6".repeat(64), approvals: [{ approverId: "approver-1", issuedAt: at(15) }], startedAt: at(20), finishedAt: at(25) }),
    contract: pinned, sourceCommit: commit, targetHardwareId: target, attestedBy: "operator", now: new Date(Date.UTC(2026, 9, 12, 13)),
  });
  assert.ok(built.ok);
  const recovery = built.evidence;
  assert.equal(recovery.requiredApprovals, 1);
  assert.equal(await status("act-run-recovery", "ACT_RECOVERY", recovery), "EVIDENCE_PRESENT");
  // The same document relabeled to PROD with its one approval is internally consistent (the validator alone admits it) but the pinned contract requires two for PROD: refused.
  const prod = { ...recovery, environment: "PROD", interrupted: { ...recovery.interrupted, environment: "PROD" }, resumed: { ...recovery.resumed, environment: "PROD" } };
  assert.equal(await status("act-run-recovery", "ACT_RECOVERY", prod), "BLOCKED", "PROD claiming one approval under a contract that requires two");
  // Another contract than the pinned one, consistently cited, is refused too.
  const other = { ...recovery, contractSha256: "9".repeat(64), interrupted: { ...recovery.interrupted, contractSha256: "9".repeat(64) }, resumed: { ...recovery.resumed, contractSha256: "9".repeat(64) },
    checks: recovery.checks.map((c) => (c.name === "pilot-contract" ? { ...c, evidenceSha256: "9".repeat(64) } : c)) };
  assert.equal(await status("act-run-recovery", "ACT_RECOVERY", other), "BLOCKED", "another contract");
  // A release with no pilot scope binds neither (the existing non-pilot checks stand): the same PROD document is admitted by the validator alone.
  assert.equal(await status("act-run-recovery", "ACT_RECOVERY", prod, { ...input([]), records: [] }), "EVIDENCE_PRESENT", "no pilot scope, no binding");
});

test("a PILOT release with no contract, or a disabled one, is rejected", async () => {
  writeContract(true);
  const enabled = loadPinned();
  assert.equal(enabled.enabled, true);
  const scope = { provider: "AZURE", engine: "TERRAFORM", contractSha256: pilotContractSha256(enabled as PilotContract) };
  assert.deepEqual(actBlockers(await review(pilotInput(scope))), ["ACT_PILOT_CONTRACT_MISSING_OR_DISABLED"]);
  writeContract(false);
  const disabled = loadPinned();
  assert.equal(disabled.enabled, false);
  assert.deepEqual(actBlockers(await review(pilotInput(scope), disabled)), ["ACT_PILOT_CONTRACT_MISSING_OR_DISABLED"]);
  assert.deepEqual(actBlockers(await review(pilotInput(scope), loadPinned(join(pilotRoot, "absent.json")))), ["ACT_PILOT_CONTRACT_MISSING_OR_DISABLED"]);
});

test("an enabled contract for a release that does not declare the pilot is rejected", async () => {
  writeContract(true);
  const enabled = loadPinned();
  const result = await review(input([]), enabled);
  assert.deepEqual(actBlockers(result), ["ACT_PILOT_CONTRACT_ENABLED_FOR_NON_PILOT_RELEASE"]);
  assert.equal(result.readyForIndependentReleaseReview, false);
  assert.equal(result.actPilot, null);
  // Without a contract (or with a disabled one) the ordinary release is unchanged.
  assert.deepEqual(actBlockers(await review(input([]))), []);
});

test("a PILOT release must name this contract, this provider and this engine, and nothing else", async () => {
  writeContract(true);
  const enabled = loadPinned() as PilotContract;
  const good = { provider: "AZURE", engine: "TERRAFORM", contractSha256: pilotContractSha256(enabled) };
  for (const scope of [
    undefined, null, "AZURE", [], {}, { ...good, contractSha256: "0".repeat(64) }, { ...good, provider: "AWS" }, { ...good, engine: "PULUMI" },
    { ...good, extra: true }, { provider: good.provider, engine: good.engine },
  ]) {
    const result = await review(pilotInput(scope), enabled);
    assert.deepEqual(actBlockers(result), ["ACT_PILOT_SCOPE_MISMATCH"], JSON.stringify(scope));
    assert.equal(result.actPilot, null);
  }
  // Editing the contract after the release named it breaks the binding.
  writeContract(true, 61);
  assert.deepEqual(actBlockers(await review(pilotInput(good), loadPinned())), ["ACT_PILOT_SCOPE_MISMATCH"]);
});

test("the release checks the same committed pin the loader does: a contract the pin does not name is rejected", async () => {
  writeContract(true);
  const enabled = loadPinned() as PilotContract;
  const scope = { provider: "AZURE", engine: "TERRAFORM", contractSha256: pilotContractSha256(enabled) };
  // A hand-built or stale contract object that was never loaded through the pin.
  const edited = { ...enabled, maxApprovalAgeMinutes: 61 };
  const editedScope = { ...scope, contractSha256: pilotContractSha256(edited) };
  for (const [manifestScope, contract] of [[editedScope, edited], [scope, edited]] as const) {
    const result = await review(pilotInput(manifestScope), contract);
    assert.deepEqual(actBlockers(result), ["ACT_PILOT_CONTRACT_NOT_PINNED"]);
    assert.equal(result.actPilot, null);
  }
  // An absent, empty or malformed pin pins nothing.
  for (const pin of [null, "", "\n", "not a hash", "0".repeat(64)]) {
    if (pin === null) rmSync(pinPath, { force: true }); else writeFileSync(pinPath, pin);
    assert.deepEqual(actBlockers(await review(pilotInput(scope), enabled)), ["ACT_PILOT_CONTRACT_NOT_PINNED"], JSON.stringify(pin));
  }
  writeContract(true);
  assert.deepEqual(actBlockers(await review(pilotInput(scope), enabled)), []);
});

test("an actPilot object on any release that is not PILOT is rejected, with or without a contract", async () => {
  writeContract(true);
  const enabled = loadPinned() as PilotContract;
  const scope = { provider: "AZURE", engine: "TERRAFORM", contractSha256: pilotContractSha256(enabled) };
  for (const stray of [scope, {}, null, "AZURE", []]) {
    for (const contract of [undefined, enabled]) {
      const result = await review(pilotInput(stray, "DISABLED"), contract);
      assert.ok(actBlockers(result).includes("ACT_PILOT_SCOPE_ON_NON_PILOT_RELEASE"), JSON.stringify(stray));
      assert.equal(result.readyForIndependentReleaseReview, false);
      assert.equal(result.actPilot, null);
    }
  }
});

test("a valid pilot release is representable, still not ready without evidence, and production stays unapproved", async () => {
  writeContract(true);
  const enabled = loadPinned() as PilotContract;
  const scope = { provider: "AZURE", engine: "TERRAFORM", contractSha256: pilotContractSha256(enabled) };
  const result = await review(pilotInput(scope), enabled);
  assert.deepEqual(actBlockers(result), []);
  assert.deepEqual(result.actPilot, scope);
  assert.equal(result.infrastructureAct, "DISABLED", "ACT is disabled globally; the pilot contract is its only exception");
  assert.equal(result.productionReleaseApproved, false);
  assert.equal(result.readyForIndependentReleaseReview, false, "every release gate still needs its own evidence");
  assert.ok(result.gates.every((g) => g.status === "BLOCKED"));
});

test("any other infrastructureAct value is still rejected, with or without a contract", async () => {
  writeContract(true);
  const enabled = loadPinned() as PilotContract;
  const scope = { provider: "AZURE", engine: "TERRAFORM", contractSha256: pilotContractSha256(enabled) };
  for (const value of ["ENABLED", "pilot", "ACT", "", "DISABLED "]) {
    for (const contract of [undefined, enabled]) {
      const result = await review(pilotInput(scope, value), contract);
      assert.ok(result.blockers.includes("RELEASE_MANIFEST_CONTRACT_OR_COMMIT_INVALID"), JSON.stringify(value));
      assert.equal(result.readyForIndependentReleaseReview, false);
    }
  }
});

test("each listed provider/engine pair is admitted on its own; an unlisted pair is not, even when pinned and named", async () => {
  writeContract(true);
  const base = loadPinned() as PilotContract;
  const attempt = async (provider: string, engine: string) => {
    const contract = { ...base, provider, engine } as unknown as PilotContract;
    writeFileSync(pinPath, pilotContractSha256(contract) + "\n");
    const scope = { provider, engine, contractSha256: pilotContractSha256(contract) };
    return actBlockers(await review(pilotInput(scope), contract));
  };
  for (const [provider, engine] of [["AZURE", "TERRAFORM"], ["AWS", "TERRAFORM"], ["AWS", "CDK"]]) {
    assert.deepEqual(await attempt(provider, engine), [], provider + "/" + engine);
  }
  for (const [provider, engine] of [["AZURE", "CDK"], ["GCP", "TERRAFORM"], ["AWS", "PULUMI"], ["*", "*"]]) {
    assert.deepEqual(await attempt(provider, engine), ["ACT_PILOT_COMBINATION_NOT_ALLOWED"], provider + "/" + engine);
  }
});

test("a live ACT gate admits only the record-live record of its own path, commit and a successful apply", async () => {
  const h = harness();
  try {
    const id = "act:aws-terraform";
    const record = {
      schemaVersion: 1, label: "LIVE", step: "execute", cloud: "AWS", engine: "TERRAFORM", environment: "DEV",
      target: { accountId: "000000000000" }, sourceCommit: commit, artifactSha256: "1".repeat(64), outcome: "SUCCEEDED",
      evidenceSha256: "2".repeat(64), contractSha256: "3".repeat(64), attestedBy: "owner", attestedAt: "2026-10-25T00:00:00.000Z",
    };
    const status = async (payload: object, gate = id) => (await reviewProductionRelease({
      manifest: input([h.attach(gate, "LIVE_ACT", payload)]), expectedCommit: commit, root: h.root,
    })).gates.find((g) => g.id === gate)?.status;
    assert.equal(await status(record), "EVIDENCE_PRESENT");
    assert.equal(await status(record, "act:aws-cdk"), "BLOCKED");
    for (const change of [{ engine: "CDK" }, { sourceCommit: "c".repeat(40) }, { outcome: "PARTIAL_REQUIRES_REVIEW" },
      { label: "SYNTHETIC" }, { attestedBy: " " }, { evidenceSha256: "short" }, { fixture: true }]) {
      assert.equal(await status({ ...record, ...change }), "BLOCKED", JSON.stringify(change));
    }
  } finally { h.cleanup(); }
});

test("a platform gate needs its own host, version, artifact digest and all seven lifecycle checks", async () => {
  const h = harness();
  try {
    const id = "platform:linux-x64";
    const names = ["install", "launch", "uninstall", "repeat-uninstall", "partial-install-recovery", "unusual-paths", "unrelated-files-preserved"];
    const report = {
      ...generic(id, "LIFECYCLE"), platform: "linux-x64", osVersion: "Ubuntu 24.04", artifactSha256: "4".repeat(64),
      checks: names.map((name) => ({ name, passed: true, evidenceSha256: "b".repeat(64) })),
    };
    const status = async (payload: object) => (await reviewProductionRelease({
      manifest: input([h.attach(id, "LIFECYCLE", payload)]), expectedCommit: commit, root: h.root,
    })).gates.find((g) => g.id === id)?.status;
    assert.equal(await status(report), "EVIDENCE_PRESENT");
    for (const change of [{ platform: "linux-arm64" }, { osVersion: "" }, { artifactSha256: undefined }, { checks: report.checks.slice(1) }]) {
      assert.equal(await status({ ...report, ...change }), "BLOCKED", JSON.stringify(change));
    }
  } finally { h.cleanup(); }
});

test("independent review refuses self-review and open blocking findings; ACT recovery must reconcile, never resume unapproved", async () => {
  const h = harness();
  try {
    const review = { ...generic("security-review:independent", "INDEPENDENT_REVIEW"), reviewer: "reviewer-1", reviewerIsAuthor: false, blockingFindingsOpen: 0 };
    // The recovery gate takes only the product's own record (src/apply/recovery-record.ts): the four fields are derived from two ledger
    // evidences, so the fixture is built by the producer; a bare document that states the four fields is a hand-written one, refused.
    const contract = awsContractJson("/nonexistent/kill") as unknown as PilotContract;
    const at = (minutes: number): string => new Date(Date.UTC(2026, 9, 12, 12, minutes)).toISOString();
    const apply = (over: Partial<ApplyEvidence>): ApplyEvidence => ({
      schemaVersion: 1, environment: "DEV", target: { account: "111111111111", backend: "b", workspace: "default" }, artifactSha256: "5".repeat(64), manifestHash: "2".repeat(64),
      releaseIdentity: "3".repeat(64), contractSha256: pilotContractSha256(contract), sourceCommit: commit, approvals: [{ approverId: "alice", issuedAt: at(-30) }], requester: { requesterId: "carol", nonce: "0".repeat(32) }, 
      adapter: { adapterVersion: "a", argvDigest: "4".repeat(64) }, toolVersions: { engine: "1.9.5" }, outcome: "SUCCEEDED", exitCode: 0, startedAt: at(-10), finishedAt: at(0), authority: APPLY_AUTHORITY, ...over,
    });
    const built = buildRecoveryEvidence({
      interrupted: apply({ outcome: "KILLED", exitCode: null }), resumed: apply({ artifactSha256: "6".repeat(64), approvals: [{ approverId: "alice", issuedAt: at(15) }], startedAt: at(20), finishedAt: at(25) }),
      contract, sourceCommit: commit, targetHardwareId: target, attestedBy: "operator", now: new Date(Date.UTC(2026, 9, 12, 13)),
    });
    assert.ok(built.ok);
    const recovery = built.evidence;
    const bare = { ...generic("act-run-recovery", "ACT_RECOVERY"), actEnabled: true, interruptedArtifactSha256: "5".repeat(64), interruptedOutcome: "KILLED", reconciledFromLedger: true, resumedWithoutApproval: false };
    const status = async (id: string, mode: ReleaseGateSubmission["mode"], payload: object) => (await reviewProductionRelease({
      manifest: input([h.attach(id, mode, payload)]), expectedCommit: commit, root: h.root,
    })).gates.find((g) => g.id === id)?.status;
    assert.equal(await status("security-review:independent", "INDEPENDENT_REVIEW", review), "EVIDENCE_PRESENT");
    assert.equal(await status("security-review:independent", "INDEPENDENT_REVIEW", { ...review, reviewerIsAuthor: true }), "BLOCKED");
    assert.equal(await status("security-review:independent", "INDEPENDENT_REVIEW", { ...review, blockingFindingsOpen: 1 }), "BLOCKED");
    assert.equal(await status("security-review:independent", "INDEPENDENT_REVIEW", { ...review, actEnabled: true }), "BLOCKED");
    assert.equal(await status("act-run-recovery", "ACT_RECOVERY", recovery), "EVIDENCE_PRESENT");
    assert.equal(await status("act-run-recovery", "ACT_RECOVERY", { ...recovery, resumedWithoutApproval: true }), "BLOCKED");
    assert.equal(await status("act-run-recovery", "ACT_RECOVERY", { ...recovery, interruptedOutcome: "SUCCEEDED" }), "BLOCKED");
    assert.equal(await status("act-run-recovery", "ACT_RECOVERY", { ...recovery, interrupted: { ...recovery.interrupted, outcome: "SUCCEEDED" } }), "BLOCKED", "relabeled over a run that was not interrupted");
    assert.equal(await status("act-run-recovery", "ACT_RECOVERY", { ...recovery, resumed: { ...recovery.resumed, approvals: [{ approverId: "alice", issuedAt: at(-30) }] } }), "BLOCKED", "an approval carried over");
    assert.equal(await status("act-run-recovery", "ACT_RECOVERY", bare), "BLOCKED", "a hand-written document is not the producer's");
  } finally { h.cleanup(); }
});

test("a gate the owner's scope excludes is reported OUT_OF_SCOPE, and evidence or an unknown gate in the exclusion is refused", async () => {
  const h = harness();
  try {
    const excluded = "preview:pulumi-aws-greenfield";
    const others = PRODUCTION_RELEASE_GATES.filter((g) => g.id !== excluded).map((g) => g.id);
    const review = await reviewProductionRelease({ manifest: input([]), expectedCommit: commit, root: h.root, outOfScope: [excluded] });
    assert.equal(review.gates.find((g) => g.id === excluded)?.status, "OUT_OF_SCOPE");
    assert.equal(review.readyForIndependentReleaseReview, false);
    const all = await reviewProductionRelease({ manifest: input([]), expectedCommit: commit, root: h.root, outOfScope: others });
    assert.equal(all.gates.find((g) => g.id === excluded)?.status, "BLOCKED", "only excluded gates are skipped");
    const evidenced = await reviewProductionRelease({
      manifest: input([h.attach(excluded, "LIVE_PREVIEW", generic(excluded, "LIVE_PREVIEW"))]), expectedCommit: commit, root: h.root, outOfScope: [excluded],
    });
    assert.ok(evidenced.blockers.includes("RELEASE_RECORD_FOR_OUT_OF_SCOPE_GATE:" + excluded));
    const unknown = await reviewProductionRelease({ manifest: input([]), expectedCommit: commit, root: h.root, outOfScope: ["preview:nope"] });
    assert.ok(unknown.blockers.includes("RELEASE_SCOPE_UNKNOWN_GATE:preview:nope"));
  } finally { h.cleanup(); }
});
