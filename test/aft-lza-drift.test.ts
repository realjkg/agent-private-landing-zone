import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { AwsCliReader, EXECUTION_WINDOW, type AwsExec } from "../src/aft-lza/aws-reader.js";
import { DRIFT_EXIT, collectDrift, detectDrift, driftMarkdown, driftReport, type DriftObservations, type DriftReaders } from "../src/aft-lza/drift.js";
import { GitHubReader, type Fetcher } from "../src/aft-lza/github-reader.js";
import type { AftLzaCard, PipelineObservation } from "../src/aft-lza/workflow.js";

// SYNTHETIC: every observation below is a fixture. None of it is AWS or GitHub evidence.

const L = "1".repeat(40), A = "2".repeat(40), ID = "111122223333", OU = "ou-ab12-cdef3456";
const card: AftLzaCard = {
  runId: "pilot-001", organizationId: "o-abcdefghij", homeRegion: "us-east-1", regions: ["us-east-1", "us-west-2"],
  account: { name: "pilot-nonprod", email: "pilot+np@example.com", ouId: OU },
  lza: { repository: "acme/lza-config", baseBranch: "main", pipelineName: "AWSAccelerator-Pipeline", configurationDigest: "a".repeat(64) },
  aft: { repository: "acme/aft-account-request", baseBranch: "main", requestPipelineName: "ct-aft-account-request", requestDigest: "c".repeat(64), requestedName: "pilot-nonprod", requestedEmail: "pilot+np@example.com" },
  disposition: "RETAIN",
};
const run = (pipelineName: string, rev: string, status: PipelineObservation["status"] = "Succeeded", executionId = "e-" + rev.slice(0, 4)): PipelineObservation =>
  ({ pipelineName, executionId, sourceRevision: rev, status, evidence: "OBSERVED" });
const synced = (over: Partial<DriftObservations> = {}): DriftObservations => ({
  landingZone: { arn: "arn:aws:controltower:us-east-1:000000000000:landingzone/LZ", driftStatus: "IN_SYNC" },
  baselines: [{ arn: "arn:baseline/1", driftStatus: "IN_SYNC" }],
  controls: [{ arn: "arn:control/1", driftStatus: "IN_SYNC" }],
  stackRegionsRead: ["us-east-1", "us-west-2"],
  lzaStacks: [{ region: "us-east-1", stackName: "AWSAccelerator-SecurityStack", driftStatus: "IN_SYNC" }, { region: "us-west-2", stackName: "AWSAccelerator-SecurityStack", driftStatus: "IN_SYNC" }],
  accountId: ID, accountParentOuId: OU, accountLookup: "FOUND",
  lzaBranchHead: L, aftBranchHead: A,
  lzaExecutions: [run("AWSAccelerator-Pipeline", "9".repeat(40)), run("AWSAccelerator-Pipeline", L)],
  aftExecutions: [run("ct-aft-account-request", A)],
  customizationExecutions: [run(ID + "-customizations-pipeline", "x".repeat(40))],
  ...over,
});
const only = (obs: DriftObservations, kind: string) => detectDrift(card, obs).filter((f) => f.kind === kind);

test("a fully observed, matching estate is IN_SYNC and exits 0", () => {
  const report = driftReport(card, synced(), "2026-11-12T00:00:00.000Z", "SYNTHETIC");
  assert.equal(report.verdict, "IN_SYNC");
  assert.equal(report.counts.DRIFTED + report.counts.UNKNOWN, 0);
  assert.equal(DRIFT_EXIT[report.verdict], 0);
  assert.equal(report.autoRepair, false);
  assert.equal(report.deploymentAuthorized, false);
  assert.equal(report.gate, "act:aws-aft-lza");
});

test("each drift kind is detected and routed to its owner", () => {
  const cases: Array<[string, Partial<DriftObservations>, string]> = [
    ["LANDING_ZONE", { landingZone: { arn: "lz", driftStatus: "DRIFTED" } }, "CONTROL_TOWER"],
    ["BASELINE", { baselines: [{ arn: "b", driftStatus: "DRIFTED" }] }, "CONTROL_TOWER"],
    ["CONTROL", { controls: [{ arn: "c", driftStatus: "DRIFTED" }] }, "CONTROL_TOWER"],
    ["LZA_STACK", { lzaStacks: [{ region: "us-east-1", stackName: "AWSAccelerator-SecurityStack", driftStatus: "DRIFTED" }, { region: "us-west-2", stackName: "AWSAccelerator-SecurityStack", driftStatus: "IN_SYNC" }] }, "LZA"],
    ["ACCOUNT_PLACEMENT", { accountParentOuId: "ou-ab12-other0000" }, "LZA"],
    ["LZA_UNDEPLOYED", { lzaBranchHead: "3".repeat(40) }, "LZA"],
    ["AFT_UNDEPLOYED", { aftBranchHead: "4".repeat(40) }, "AFT"],
    ["AFT_CUSTOMIZATION", { customizationExecutions: [run(ID + "-customizations-pipeline", "x".repeat(40), "Failed")] }, "AFT"],
  ];
  for (const [kind, over, owner] of cases) {
    const report = driftReport(card, synced(over), "t", "SYNTHETIC");
    const drifted = report.findings.filter((f) => f.state === "DRIFTED");
    assert.deepEqual(drifted.map((f) => f.kind), [kind], kind);
    assert.equal(drifted[0]!.owner, owner, kind);
    assert.equal(report.verdict, "DRIFTED", kind);
    assert.equal(DRIFT_EXIT[report.verdict], 3);
    assert.equal(report.routes[owner as "LZA"], 1, kind);
  }
});

test("anything unread, NOT_CHECKED, NOT_CHECKING or UNKNOWN is UNKNOWN, never IN_SYNC", () => {
  const unknowns: Array<[string, Partial<DriftObservations>]> = [
    ["LANDING_ZONE", { landingZone: undefined }],
    ["BASELINE", { baselines: undefined }],
    ["BASELINE", { baselines: [] }],
    ["CONTROL", { controls: [{ arn: "c", driftStatus: "NOT_CHECKING" }] }],
    ["LZA_STACK", { lzaStacks: [{ region: "us-east-1", stackName: "AWSAccelerator-SecurityStack", driftStatus: "NOT_CHECKED" }, { region: "us-west-2", stackName: "AWSAccelerator-SecurityStack", driftStatus: "IN_SYNC" }] }],
    ["LZA_STACK", { stackRegionsRead: ["us-east-1"] }],
    ["LZA_STACK", { lzaStacks: [{ region: "us-east-1", stackName: "AWSAccelerator-SecurityStack", driftStatus: "IN_SYNC" }] }],
    ["ACCOUNT_PLACEMENT", { accountId: undefined, accountLookup: "NOT_FOUND" }],
    ["LZA_UNDEPLOYED", { lzaBranchHead: undefined }],
    ["AFT_UNDEPLOYED", { aftExecutions: undefined }],
    ["AFT_CUSTOMIZATION", { customizationExecutions: undefined }],
    ["AFT_CUSTOMIZATION", { customizationExecutions: [run(ID + "-customizations-pipeline", "x".repeat(40), "InProgress")] }],
  ];
  for (const [kind, over] of unknowns) {
    const rows = only(synced(over), kind);
    assert.ok(rows.some((f) => f.state === "UNKNOWN"), kind + " " + JSON.stringify(over));
    assert.ok(rows.every((f) => f.state !== "DRIFTED"), kind);
    const report = driftReport(card, synced(over), "t", "SYNTHETIC");
    assert.equal(report.verdict, "UNKNOWN", kind);
    assert.equal(DRIFT_EXIT[report.verdict], 2);
  }
  // DRIFTED outranks UNKNOWN in the verdict
  assert.equal(driftReport(card, synced({ landingZone: undefined, aftBranchHead: "4".repeat(40) }), "t", "SYNTHETIC").verdict, "DRIFTED");
});

test("undeployed: a running execution for the head is UNKNOWN; a truncated history is UNKNOWN; a short history with no success is DRIFTED", () => {
  assert.equal(only(synced({ lzaBranchHead: "3".repeat(40), lzaExecutions: [run("AWSAccelerator-Pipeline", L), run("AWSAccelerator-Pipeline", "3".repeat(40), "InProgress")] }), "LZA_UNDEPLOYED")[0]!.state, "UNKNOWN");
  const failed = Array.from({ length: EXECUTION_WINDOW }, (_, i) => run("AWSAccelerator-Pipeline", L, "Failed", "f" + i));
  assert.equal(only(synced({ lzaExecutions: failed }), "LZA_UNDEPLOYED")[0]!.state, "UNKNOWN");
  assert.equal(only(synced({ lzaExecutions: failed.slice(0, 2) }), "LZA_UNDEPLOYED")[0]!.state, "DRIFTED");
});

test("the markdown summary lists only findings that need attention and escapes table pipes", () => {
  const md = driftMarkdown(driftReport(card, synced({ landingZone: { arn: "lz", driftStatus: "DRIFTED" } }), "t", "SYNTHETIC"));
  assert.match(md, /^## AFT\/LZA drift: DRIFTED/);
  assert.match(md, /\| DRIFTED \| LANDING_ZONE \| CONTROL_TOWER \|/);
  assert.doesNotMatch(md, /\| IN_SYNC \|/);
  assert.match(md, /SYNTHETIC/);
  assert.match(md, /Detection only/);
});

test("collectDrift reads every signal and turns a failed read into UNKNOWN for that signal only", async () => {
  const calls: string[] = [];
  const readers: DriftReaders = {
    aws: {
      async callerArn() { return "arn:aws:sts::000000000000:assumed-role/alz-aft-lza-drift/run"; },
      async landingZone() { calls.push("lz"); return { arn: "lz", driftStatus: "IN_SYNC" }; },
      async ouArn(ou) { calls.push("ou:" + ou); return "arn:ou"; },
      async enabledOnOu() { return { baselines: [{ arn: "b", driftStatus: "IN_SYNC" }], controls: [{ arn: "c", driftStatus: "IN_SYNC" }] }; },
      async lzaStacks(region) { if (region === "us-west-2") throw new Error("throttled"); return [{ region, stackName: "AWSAccelerator-SecurityStack", driftStatus: "IN_SYNC" }]; },
      async findAccountByEmail() { return { lookup: "FOUND", account: { accountId: ID, parentOuId: OU } }; },
      async pipelineExecutions(name) {
        if (name === "AWSAccelerator-Pipeline") return [run(name, L)];
        if (name === "ct-aft-account-request") return [run(name, A)];
        return [run(name, "x".repeat(40))];
      },
    },
    github: { async branchHead(repo) { return repo === "acme/lza-config" ? L : A; } },
  };
  const obs = await collectDrift(card, readers);
  assert.deepEqual(obs.stackRegionsRead, ["us-east-1"]);
  const report = driftReport(card, obs, "t", "SYNTHETIC");
  assert.equal(report.verdict, "UNKNOWN");
  assert.deepEqual(report.findings.filter((f) => f.state !== "IN_SYNC").map((f) => [f.kind, f.region]), [["LZA_STACK", "us-west-2"]]);
  assert.ok(calls.includes("ou:" + OU));
  assert.equal(report.callerArn, "arn:aws:sts::000000000000:assumed-role/alz-aft-lza-drift/run");
  assert.match(driftMarkdown(report), /as `arn:aws:sts::000000000000:assumed-role\/alz-aft-lza-drift\/run`/);
});

test("the AWS reader issues only allow-listed read calls and maps Control Tower and CloudFormation drift", async () => {
  const calls: string[][] = [];
  const ok = (value: unknown) => ({ code: 0, stderr: "", stdout: JSON.stringify(value) });
  const exec: AwsExec = async (args) => {
    calls.push(args);
    switch (args[1]) {
      case "list-landing-zones": return ok({ landingZones: [{ arn: "arn:lz" }] });
      case "get-landing-zone": return ok({ landingZone: { driftStatus: { status: "DRIFTED" } } });
      case "describe-organizational-unit": return ok({ OrganizationalUnit: { Arn: "arn:ou" } });
      case "list-enabled-baselines": return ok({ enabledBaselines: [{ arn: "b1", driftStatusSummary: { types: { inheritance: { status: "IN_SYNC" } } } }, { arn: "b2", driftStatusSummary: { driftStatus: "DRIFTED" } }] });
      case "list-enabled-controls": return { code: 254, stdout: "", stderr: "AccessDeniedException" };
      case "describe-stacks": return ok({ Stacks: [{ StackName: "AWSAccelerator-SecurityStack", DriftInformation: { StackDriftStatus: "NOT_CHECKED" } }, { StackName: "unrelated" }] });
      case "list-pipeline-executions": return { code: 254, stdout: "", stderr: "AccessDeniedException" };
      default: return { code: 1, stdout: "", stderr: "unexpected" };
    }
  };
  const reader = new AwsCliReader(exec);
  assert.deepEqual(await reader.landingZone("us-east-1"), { arn: "arn:lz", driftStatus: "DRIFTED" });
  assert.equal(await reader.ouArn(OU), "arn:ou");
  const on = await reader.enabledOnOu("arn:ou", "us-east-1");
  assert.deepEqual(on.baselines, [{ arn: "b1", driftStatus: "IN_SYNC" }, { arn: "b2", driftStatus: "DRIFTED" }]);
  assert.equal(on.controls, undefined);
  assert.deepEqual(await reader.lzaStacks("us-west-2"), [{ region: "us-west-2", stackName: "AWSAccelerator-SecurityStack", driftStatus: "NOT_CHECKED" }]);
  await assert.rejects(reader.pipelineExecutions("AWSAccelerator-Pipeline", "us-east-1"), /AWS_READ_DENIED/);
  for (const args of calls) {
    assert.match(args.slice(0, 2).join(" "), /^(controltower (list-landing-zones|get-landing-zone|list-enabled-baselines|list-enabled-controls)|organizations describe-organizational-unit|cloudformation describe-stacks|codepipeline list-pipeline-executions)$/);
    assert.ok(!args.includes("detect-stack-drift"));
  }
  const source = readFileSync("src/aft-lza/aws-reader.ts", "utf8");
  assert.doesNotMatch(source, /detect-stack-drift|reset-|update-|create-|delete-|start-|enable-|disable-/);
});

test("the GitHub reader is GET-only, validates names, and never treats an unreadable branch as a commit", async () => {
  const seen: Array<{ url: string; method: string; auth?: string }> = [];
  const fetcher: Fetcher = async (url, init) => {
    seen.push({ url, method: init.method, auth: init.headers.Authorization });
    if (url.endsWith("/acme/lza-config/commits/main")) return { status: 200, json: async () => ({ sha: L }) };
    if (url.includes("/bad-sha/")) return { status: 200, json: async () => ({ sha: "not-a-sha" }) };
    return { status: 404, json: async () => ({}) };
  };
  const gh = new GitHubReader("token-value", fetcher);
  assert.equal(await gh.branchHead("acme/lza-config", "main"), L);
  assert.equal(await gh.branchHead("acme/missing", "main"), undefined);
  assert.equal(await gh.branchHead("acme/bad-sha", "main"), undefined);
  await assert.rejects(gh.branchHead("acme/../x", "main"), /INVALID/);
  await assert.rejects(gh.branchHead("acme/x", "a..b"), /INVALID/);
  assert.equal(await new GitHubReader(undefined, fetcher).branchHead("acme/lza-config", "main"), undefined);
  assert.equal(seen.length, 3);
  assert.ok(seen.every((s) => s.method === "GET" && s.url.startsWith("https://api.github.com/repos/")));
});

test("the drift workflow is read-only, federated, pinned and not able to apply", () => {
  const yml = readFileSync(".github/workflows/aft-lza-drift.yml", "utf8");
  assert.match(yml, /^permissions:\n  contents: read\n/m);
  assert.match(yml, /id-token: write/);
  assert.match(yml, /environment: aft-lza-drift/);
  assert.match(yml, /AWS_WEB_IDENTITY_TOKEN_FILE/);
  assert.doesNotMatch(yml, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|assume-role-with-web-identity/);
  assert.doesNotMatch(yml, /contents: write|pull-requests: write|alz apply|act-pilot-contract|detect-stack-drift/);
  for (const line of yml.split("\n").filter((l) => /^\s*(-\s*)?uses:/.test(l))) assert.match(line, /@[0-9a-f]{40} # v\d+/);
  assert.match(yml, /src\/cli\/aft-lza-drift\.ts/);
});
