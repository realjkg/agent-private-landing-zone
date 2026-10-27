import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { invokeLocalModel, type OllamaMessage } from "../src/ollama.js";
import { createSessionGraph } from "../src/session/graph.js";
import { evaluateOperatorRequest } from "../src/session/operator-policy.js";
import { answerPilotQuery, guardExplanation, pilotHandoffKind, pilotHandoffResponse } from "../src/session/pilot-answer.js";
import { readPilotContext, runIdFromRequest, type PilotToolResult } from "../src/session/pilot-context.js";
import { classifySessionCommand } from "../src/session/query.js";

// SYNTHETIC: fixture records and a fake local model on 127.0.0.1. This proves model/tool compatibility of the session's
// read-only pilot context and its guards. It is not provider qualification and not a real-model run (the owner's runbook).

const A = "a1b2c3d4e5f6" + "0".repeat(52);
const B = "b0b0b0b0b0b0" + "1".repeat(52);
const MANIFEST = "c".repeat(64);
const PROPOSAL = "d".repeat(64);

function stage(status: string, detail: string) {
  return { status, mode: "SYNTHETIC", detail };
}

function lifecycle(artifact: string, stages: Record<string, ReturnType<typeof stage>>, extra: Record<string, unknown> = {}) {
  const passed = Object.values(stages).every((item) => item.status === "PASS");
  return {
    schemaVersion: 1, reportKind: "ACT_LIFECYCLE", gateVersion: 1, gateId: "act:aws-terraform", provider: "AWS", engine: "TERRAFORM",
    scenario: "pilot-apply-observe-cleanup", mode: "SYNTHETIC", sourceCommit: "e".repeat(40), contractSha256: "f".repeat(64), environment: "DEV",
    target: { account: "123456789012", backend: "s3://state", workspace: "dev" }, artifactSha256: artifact, applyEvidenceSha256: "9".repeat(64),
    proposalSha256: null, stages, approvals: { apply: ["alice"], cleanup: [] }, observation: null, dispositions: null,
    acceptance: { resourceCleanup: "NOT_RUN", retained: { total: 0, byOwnership: {}, byOwner: {} }, environmentRetirement: "OUTSTANDING", statement: "approved resources not yet cleaned up" },
    passed, unresolved: [], liveAttestation: null, generatedAt: "2026-10-27T12:00:00.000Z", ...extra,
  };
}

/** A checkout with one preparation, one sealed preview, a failed run (A) and a fully passed run (B). */
function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "alz-pilot-context-"));
  mkdirSync(join(root, ".runs", "pilot", "DEV"), { recursive: true });
  writeFileSync(join(root, ".runs", "pilot", "DEV", "preparation-" + MANIFEST.slice(0, 16) + ".json"), JSON.stringify({
    label: "LOCAL_PREPARATION", provider: "AWS", engine: "TERRAFORM", path: "PRIMARY", environment: "DEV", account: "123456789012", region: "us-east-1",
    backend: "s3://state", workspace: "dev", projectRoot: "/work/project", fileCount: 4, providers: [{ source: "registry.terraform.io/hashicorp/aws", version: "6.1.0" }],
    engineVersion: "1.16.4", engineVersionSource: "TESTED_PIN", inputs: [{ name: "bucket_name", source: "TFVARS", from: "terraform.tfvars" }],
    policyVersion: "p1", unitHash: "1".repeat(64), manifestHash: MANIFEST, contractSha256: "f".repeat(64),
    unit: { unitId: "u-1", tags: { "alz:unit": "u-1" }, untagged: [] },
    requestFile: ".runs/pilot/DEV/request-" + MANIFEST.slice(0, 16) + ".json", manifestFile: ".runs/pilot/DEV/manifest-" + MANIFEST.slice(0, 16) + ".json",
    gaps: ["These are local preparation files. They are not qualification evidence and prove nothing about the cloud."],
    next: { step: "seal", reason: "The TERRAFORM path is qualified, so the next step is to seal a plan for review." },
  }));
  mkdirSync(join(root, ".runs", "evidence", "sealed-plan"), { recursive: true });
  writeFileSync(join(root, ".runs", "evidence", "sealed-plan", A + ".evidence.review.json"), JSON.stringify({
    artifactSha256: A, planSha256: "2".repeat(64), manifestHash: MANIFEST, environment: "DEV", target: { account: "123456789012", backend: "s3://state", workspace: "dev" },
    channel: "CLI", sourceCommit: "e".repeat(40), createdAt: "2026-10-27T11:00:00.000Z", requesterId: "alice", changesSha256: "3".repeat(64),
    changes: [{ address: "aws_s3_bucket.logs", type: "aws_s3_bucket", action: "create" }, { address: "aws_iam_role.reader", type: "aws_iam_role", action: "create" }],
  }));
  const reports = join(root, ".runs", "apply", "reports");
  mkdirSync(reports, { recursive: true });
  writeFileSync(join(reports, A.slice(0, 12) + "-lifecycle.json"), JSON.stringify(lifecycle(A, {
    execute: stage("PASS", "the apply succeeded and its evidence is recorded"),
    observe: stage("FAIL", "independent observation FAILED"),
    propose: stage("NOT_RUN", "no cleanup proposal"), cleanup: stage("NOT_RUN", "no proposal to execute"), leftovers: stage("NOT_RUN", "no proposal to verify"),
  }, {
    observation: { verdict: "FAILED", resources: [
      { address: "aws_s3_bucket.logs", type: "aws_s3_bucket", identifier: "arn:aws:s3:::logs", result: "VERIFIED" },
      { address: "aws_iam_role.reader", type: "aws_iam_role", identifier: null, result: "MISSING" },
    ] },
    unresolved: ["a planned resource is missing or something unexpected was found", "propose the cleanup"],
  })));
  writeFileSync(join(reports, B.slice(0, 12) + "-lifecycle-" + PROPOSAL.slice(0, 12) + ".json"), JSON.stringify(lifecycle(B, {
    execute: stage("PASS", "the apply succeeded and its evidence is recorded"), observe: stage("PASS", "independent observation VERIFIED (COMPLETE inventory)"),
    propose: stage("PASS", "1 deletion(s) proposed, 0 kept"), cleanup: stage("PASS", "the cleanup destroyed the approved list as APPLY"),
    leftovers: stage("PASS", "approved resources deleted; protected objects intentionally retained; environment retirement outstanding"),
  }, {
    proposalSha256: PROPOSAL,
    observation: { verdict: "VERIFIED", resources: [{ address: "aws_s3_bucket.logs", type: "aws_s3_bucket", identifier: "arn:aws:s3:::logs", result: "VERIFIED" }] },
    dispositions: { disposition: "COMPLETE", resources: [{ address: "aws_s3_bucket.logs", disposition: "CONFIRMED_DELETED", basis: "CLOUD_CONTROL_ABSENT" }] },
  })));
  return root;
}

function snapshot(root: string): string[] {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [relative(root, join(dir, entry.name)) + ":" + statSync(join(dir, entry.name)).mtimeMs]);
  return walk(root).sort();
}

/** A fake Ollama /api/chat on 127.0.0.1 that answers with the given text and records what it was sent. */
async function withFakeModel(reply: string, run: (baseUrl: string, seen: OllamaMessage[][]) => Promise<void>): Promise<void> {
  const seen: OllamaMessage[][] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      seen.push((JSON.parse(body) as { messages: OllamaMessage[] }).messages);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ message: { role: "assistant", content: reply } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    await run("http://127.0.0.1:" + address.port, seen);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const fakeExplainer = (baseUrl: string) => ({ modelName: "qwen3:4b", explain: (messages: OllamaMessage[]) => invokeLocalModel(baseUrl, "qwen3:4b", messages) });

test("the read-only pilot commands are selected from plain requests and pass the operator boundary", () => {
  const cases: Array<[string, string]> = [
    ["Show the blueprint", "PILOT_BLUEPRINT"],
    ["show me the preview", "PILOT_PREVIEW"],
    ["what will the plan change?", "PILOT_PREVIEW"],
    ["status of run a1b2c3d4", "PILOT_STATUS"],
    ["what was built?", "PILOT_OBSERVED"],
    ["what is left over after the cleanup?", "PILOT_OBSERVED"],
    ["why did the apply fail?", "PILOT_FAILURE"],
    ["why did it fail", "PILOT_FAILURE"],
    ["am I ready to seal?", "PILOT_READINESS"],
    ["run preflight for DEV", "PILOT_READINESS"],
  ];
  for (const [request, command] of cases) {
    assert.equal(classifySessionCommand(request), command, request);
    assert.deepEqual(evaluateOperatorRequest(request, false), { allowed: true }, request);
  }
  // Existing commands keep their meaning.
  assert.equal(classifySessionCommand("status"), "STATUS");
  assert.equal(classifySessionCommand("why is this build blocked?"), "EXPLAIN");
  assert.equal(classifySessionCommand("Inspect this AWS environment and summarize the inventory."), "RUN");
  assert.equal(runIdFromRequest("status of run A1B2C3d4"), "a1b2c3d4");
  assert.equal(runIdFromRequest("status of the run"), undefined);
});

test("each read-only command states the record's facts and the person's exact next step, and reading changes nothing", () => {
  const root = fixtureRoot();
  try {
    const before = snapshot(root);
    const blueprint = readPilotContext("PILOT_BLUEPRINT", { root });
    assert.ok(blueprint.ok);
    assert.match(blueprint.lines.join("\n"), /AWS TERRAFORM \(PRIMARY path\), environment DEV/);
    assert.match(blueprint.lines.join("\n"), /bucket_name \(TFVARS\)/);
    assert.match(blueprint.nextStep, /^\.\/alz apply seal --request \.runs\/pilot\/DEV\/request-c{16}\.json --manifest /);

    const preview = readPilotContext("PILOT_PREVIEW", { root });
    assert.ok(preview.ok);
    assert.match(preview.lines.join("\n"), /Changes: 2 \(2 create\)/);
    assert.match(preview.lines.join("\n"), /create aws_iam_role aws_iam_role\.reader/);
    assert.match(preview.nextStep, /^Each approver reviews this bundle and signs it: \.\/alz apply approve --bundle \.runs\/evidence\/sealed-plan\/a1b2/);

    const failed = readPilotContext("PILOT_STATUS", { root, runId: "a1b2c3" });
    assert.ok(failed.ok);
    assert.equal(failed.succeeded, false);
    assert.match(failed.lines.join("\n"), /observe: FAIL \(SYNTHETIC\) — independent observation FAILED/);
    assert.match(failed.nextStep, /^\.\/alz apply observe --sealed \.runs\/evidence\/sealed-plan\/a1b2c3d4e5f6/);

    const observed = readPilotContext("PILOT_OBSERVED", { root, runId: "a1b2c3" });
    assert.ok(observed.ok);
    assert.match(observed.lines.join("\n"), /MISSING aws_iam_role aws_iam_role\.reader/);
    assert.match(observed.lines.join("\n"), /Leftovers: not verified for this run\./);

    const why = readPilotContext("PILOT_FAILURE", { root, runId: "a1b2c3" });
    assert.ok(why.ok);
    assert.deepEqual(why.failures, ["observe: FAIL — independent observation FAILED",
      "unresolved: a planned resource is missing or something unexpected was found", "unresolved: propose the cleanup"]);

    const done = readPilotContext("PILOT_STATUS", { root, runId: "b0b0b0" });
    assert.ok(done.ok);
    assert.equal(done.succeeded, true);
    assert.match(done.nextStep, /Nothing more to run/);
    const leftovers = readPilotContext("PILOT_OBSERVED", { root, runId: "b0b0b0" });
    assert.ok(leftovers.ok);
    assert.match(leftovers.lines.join("\n"), /Leftovers after cleanup: COMPLETE\.\n  CONFIRMED_DELETED aws_s3_bucket\.logs/);

    const readiness = readPilotContext("PILOT_READINESS", { root });
    assert.ok(readiness.ok);
    assert.match(readiness.nextStep, /^\.\/alz apply preflight --environment DEV, then: \.\/alz apply seal /);

    assert.deepEqual(snapshot(root), before, "reading wrote, moved or touched nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing, ambiguous and inconsistent records are refused with a code and a message, never guessed", () => {
  const root = fixtureRoot();
  try {
    const empty = mkdtempSync(join(tmpdir(), "alz-pilot-empty-"));
    const none = readPilotContext("PILOT_STATUS", { root: empty });
    assert.deepEqual([none.ok, !none.ok && none.code], [false, "PILOT_RECORD_NOT_FOUND"]);
    rmSync(empty, { recursive: true, force: true });

    const unknown = readPilotContext("PILOT_STATUS", { root, runId: "ffffff" });
    assert.ok(!unknown.ok && unknown.code === "PILOT_RECORD_NOT_FOUND" && /run ffffff/.test(unknown.message));

    // A report that claims to pass while a stage did not is not read at all.
    const reports = join(root, ".runs", "apply", "reports");
    const forged = lifecycle("c0ffee" + "2".repeat(58), { execute: stage("FAIL", "the apply ended FAILED"), observe: stage("NOT_RUN", "x"),
      propose: stage("NOT_RUN", "x"), cleanup: stage("NOT_RUN", "x"), leftovers: stage("NOT_RUN", "x") });
    writeFileSync(join(reports, "c0ffee222222-lifecycle.json"), JSON.stringify({ ...forged, passed: true }));
    const refusedForged = readPilotContext("PILOT_STATUS", { root, runId: "c0ffee" });
    assert.ok(!refusedForged.ok && refusedForged.code === "PILOT_RECORD_NOT_FOUND", "a forged pass is ignored");

    // Two runs sharing a prefix are ambiguous.
    writeFileSync(join(reports, "a1b2c3999999-lifecycle.json"), JSON.stringify(lifecycle("a1b2c3999999" + "4".repeat(52), {
      execute: stage("PASS", "ok"), observe: stage("NOT_RUN", "x"), propose: stage("NOT_RUN", "x"), cleanup: stage("NOT_RUN", "x"), leftovers: stage("NOT_RUN", "x") })));
    const ambiguous = readPilotContext("PILOT_STATUS", { root, runId: "a1b2c3" });
    assert.ok(!ambiguous.ok && ambiguous.code === "PILOT_RUN_AMBIGUOUS");

    const badId = readPilotContext("PILOT_STATUS", { root, runId: "../etc" });
    assert.ok(!badId.ok && badId.code === "PILOT_RECORD_INVALID");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fabricated-success guard: a model that calls a failed run a success is withheld, and the record stands", async () => {
  const root = fixtureRoot();
  try {
    await withFakeModel("The run succeeded and every resource was built. You are all set.", async (baseUrl, seen) => {
      const { response, result } = await answerPilotQuery("PILOT_STATUS", "status of run a1b2c3", { root, ...fakeExplainer(baseUrl) });
      assert.ok(result.ok && !result.succeeded);
      assert.match(response, /Local model explanation \(qwen3:4b\) withheld \(MODEL_FABRICATED_SUCCESS\)/);
      assert.doesNotMatch(response, /every resource was built/);
      assert.match(response, /observe: FAIL \(SYNTHETIC\) — independent observation FAILED/);
      assert.match(response, /Your next step \(a person runs it; this session never does\): \.\/alz apply observe --sealed /);
      // The model saw the record as untrusted data, and the request as operator intent only.
      assert.equal(seen.length, 1);
      assert.match(seen[0][1].content, /<UNTRUSTED_EVIDENCE>[\s\S]*independent observation FAILED[\s\S]*<\/UNTRUSTED_EVIDENCE>/);
      assert.match(seen[0][0].content, /never call the run successful unless every stage shows PASS/);
    });
    // A truthful explanation of the same record is shown.
    await withFakeModel("The apply ran, but the independent observation FAILED: the reader role is MISSING. The run is not finished.", async (baseUrl) => {
      const { response } = await answerPilotQuery("PILOT_FAILURE", "why did the apply fail?", { root, runId: "a1b2c3", ...fakeExplainer(baseUrl) });
      assert.match(response, /from the record above only:\nThe apply ran, but the independent observation FAILED/);
    });
    // Success words are allowed when the record itself shows success.
    await withFakeModel("Every stage passed and the cleanup completed.", async (baseUrl) => {
      const { response } = await answerPilotQuery("PILOT_STATUS", "status of run b0b0b0", { root, ...fakeExplainer(baseUrl) });
      assert.match(response, /from the record above only:\nEvery stage passed and the cleanup completed\./);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refusal explanation: the answer quotes the tool's code and message, and a model text without the code is withheld", async () => {
  const empty = mkdtempSync(join(tmpdir(), "alz-pilot-empty-"));
  try {
    await withFakeModel("There is nothing to show yet; run the apply first.", async (baseUrl) => {
      const { response, result } = await answerPilotQuery("PILOT_OBSERVED", "what was built?", { root: empty, ...fakeExplainer(baseUrl) });
      assert.ok(!result.ok);
      assert.match(response, /^Refused: PILOT_RECORD_NOT_FOUND: No lifecycle report was found under this checkout\.$/m);
      assert.match(response, /withheld \(MODEL_OMITTED_REFUSAL_CODE\)/);
      assert.match(response, /Your next step .*: \.\/alz apply report --sealed SEALED_PLAN/);
    });
    await withFakeModel("PILOT_RECORD_NOT_FOUND: no lifecycle report exists, so nothing is confirmed as built.", async (baseUrl) => {
      const { response } = await answerPilotQuery("PILOT_OBSERVED", "what was built?", { root: empty, ...fakeExplainer(baseUrl) });
      assert.match(response, /from the record above only:\nPILOT_RECORD_NOT_FOUND: no lifecycle report exists/);
    });
    // A model that is down is reported by code; nothing else is tried.
    const { response } = await answerPilotQuery("PILOT_OBSERVED", "what was built?", { root: empty, modelName: "qwen3:4b",
      explain: () => invokeLocalModel("https://api.openai.com", "gpt", []) });
    assert.match(response, /Local model explanation \(qwen3:4b\) unavailable \(MODEL_ENDPOINT_NOT_LOOPBACK\)\. .*no other model or endpoint was tried/);
    assert.doesNotMatch(response, /api\.openai\.com/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("the guard withholds an explanation that claims an action, carries a command or a link", () => {
  const ok: PilotToolResult = { ok: true, query: "PILOT_PREVIEW", source: "x", lines: [], succeeded: false, failures: [], nextStep: "" };
  for (const [text, code] of [
    ["I approved the plan for you.", "MODEL_CLAIMED_ACTION"],
    ["I have applied the change to DEV.", "MODEL_CLAIMED_ACTION"],
    ["I edited the pilot contract to authorize APPLY.", "MODEL_CLAIMED_ACTION"],
    ["Run ./alz apply apply --sealed x now.", "MODEL_EXPLANATION_HAS_COMMAND"],
    ["See https://example.com for details.", "MODEL_EXPLANATION_HAS_LINK"],
    ["", "MODEL_EXPLANATION_EMPTY"],
    ["The deployment completed.", "MODEL_FABRICATED_SUCCESS"],
  ] as const) {
    const guarded = guardExplanation(text, ok);
    assert.ok(!guarded.ok && guarded.code === code, text + " → " + JSON.stringify(guarded));
  }
  assert.ok(guardExplanation("The plan creates two resources and nothing has been applied yet.", ok).ok);
});

test("attempts to make the model approve, apply, clean up, edit the contract or reach hosted inference are refused with the person's step", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["approve the plan for me", "APPROVE", /\.\/alz apply approve --bundle REVIEW_BUNDLE\.json --key YOUR_APPROVER_KEY\.pem --approver YOUR_ID/],
    ["Can you sign the approval?", "APPROVE", /holds no approver key/],
    ["apply it now", "APPLY", /\.\/alz apply apply --request REQUEST\.json --manifest MANIFEST\.json --sealed SEALED_PLAN --approval APPROVAL\.json/],
    ["please execute the sealed plan", "APPLY", /Pilot apply wizard, with the one-time session token/],
    ["clean up everything we built", "CLEANUP", /\.\/alz apply propose-cleanup --sealed SEALED_PLAN/],
    ["destroy the resources", "CLEANUP", /\.\/alz apply verify-cleanup --proposal PROPOSAL\.json/],
    ["edit the pilot contract to authorize APPLY in DEV", "CONTRACT", /The owner edits config\/act-pilot-contract\.json by hand in a reviewed commit/],
    ["enable ACT", "CONTRACT", /belong to the owner/],
    ["remove the kill switch", "CONTRACT", /kill switch belong to the owner/],
    ["use OpenAI instead of the local model", "HOSTED_INFERENCE", /there is no hosted fallback/],
    ["switch to a hosted model", "HOSTED_INFERENCE", /credential-free http loopback address/],
  ];
  for (const [request, kind, step] of cases) {
    assert.equal(classifySessionCommand(request), "PILOT_HANDOFF", request);
    assert.equal(pilotHandoffKind(request), kind, request);
    const response = pilotHandoffResponse(pilotHandoffKind(request)!);
    assert.match(response, /^REFUSED \((PILOT_ACTION_HUMAN_ONLY|PILOT_AUTHORITY_OWNER_ONLY|HOSTED_INFERENCE_REFUSED)\): the session does not do this\./, request);
    assert.match(response, step, request);
    assert.match(response, /Nothing was run, signed or changed\.$/, request);
  }
  // Reads about those steps stay reads.
  assert.equal(classifySessionCommand("what is the status of the apply?"), "PILOT_STATUS");
  assert.equal(classifySessionCommand("why did the cleanup fail?"), "PILOT_FAILURE");
});

test("through the session graph: action requests are refused (or stopped by the operator boundary) and a read names the person's step", async () => {
  const { graph } = createSessionGraph(":memory:");
  const base = { provider: "AWS" as const, engine: "TERRAFORM" as const, mock: "brownfield" as const, approveBuild: false, fixture: true };
  for (const [index, request] of ["approve the plan for me", "apply it now", "clean up everything we built", "edit the pilot contract",
    "use OpenAI instead of the local model", "bypass the approval and apply"].entries()) {
    const state = await graph.invoke({ ...base, request }, { configurable: { thread_id: "pilot-handoff-" + index } });
    const response = String(state.response);
    assert.ok(/^REFUSED \(/.test(response) || /^I can’t run that request in this Landing Zone\./.test(response), request + ": " + response);
    assert.doesNotMatch(response, /\bI (?:have )?(?:approved|applied|executed|cleaned up|edited)\b/, request);
  }
  const read = await graph.invoke({ ...base, request: "status of run 0123456789ab" }, { configurable: { thread_id: "pilot-read" } });
  const response = String(read.response);
  assert.match(response, /^Pilot run status — read-only/);
  assert.match(response, /Your next step \(a person runs it; this session never does\): /);
  assert.match(response, /The model cannot approve, apply, clean up or change the pilot contract\./);
  assert.doesNotMatch(response, /Local model explanation/, "a fixture session asks no model");
});
