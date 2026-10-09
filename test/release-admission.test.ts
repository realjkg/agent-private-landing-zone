import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PRODUCTION_RELEASE_GATES,
  reviewProductionRelease,
  type ReleaseAdmissionInput,
  type ReleaseGateSubmission,
} from "../src/release/admission.js";

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
