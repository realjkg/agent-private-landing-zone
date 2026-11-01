import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assessReadiness, costReadiness, COST_STATUS_MAX_AGE_HOURS, FINANCIAL_CHECK, type ReadinessInput, type ReadinessReport } from "../src/apply/readiness.js";
import type { PilotContract } from "../src/apply/types.js";
import { writeCostSnapshot } from "../src/cost/local.js";
import { costStatusOf, type CostVariant } from "./helpers/cost-fixtures.js";
import { cdkContractJson, cdkIdentityEnv } from "./helpers/cdk-fixtures.js";
import {
  awsContractJson, awsIdentityEnv, contractJson, identityEnv, installFakeTerraform, NOW, testFixtureForgeQualificationEvidence, writeReviewedContract,
} from "./helpers/apply-fixtures.js";

// The one readiness definition (src/apply/readiness.ts). Fake tools and fixture qualification evidence only: it reads, never runs.
process.env.AGENTIC_EVIDENCE_KEY ??= randomBytes(32).toString("base64");

const root = mkdtempSync(join(tmpdir(), "alz-readiness-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
const fresh = (label: string): string => { const dir = join(root, label + "-" + ++counter); mkdirSync(dir, { recursive: true }); return dir; };
const toolDir = fresh("tools");
installFakeTerraform(toolDir);

async function world(contract: (kill: string) => unknown = (kill) => contractJson(kill), qualified: "AZURE" | "AWS" | false = "AZURE") {
  const dir = fresh("world");
  const kill = join(dir, "KILL");
  const contractPath = join(dir, "contract.json");
  writeReviewedContract(contractPath, contract(kill));
  const vault = join(dir, "vault");
  mkdirSync(vault);
  if (qualified) await testFixtureForgeQualificationEvidence(vault, undefined, qualified);
  const input: ReadinessInput = {
    environment: "DEV", contractPath, qualificationDir: vault, toolDirs: [toolDir],
    env: qualified === "AWS" ? awsIdentityEnv("DEV") : identityEnv("DEV"), now: () => NOW, costStatusPath: join(dir, "cost-status.json"),
  };
  return { input, kill, contractPath };
}
const item = (report: ReadinessReport, prefix: string) => report.checks.find((c) => c.check.startsWith(prefix))!;

test("a qualified machine is ready for both clouds, with nothing next and no responsible party on any item", async () => {
  for (const [cloud, contract] of [["AZURE", (k: string) => contractJson(k)], ["AWS", (k: string) => awsContractJson(k)]] as const) {
    const { input } = await world(contract, cloud);
    const report = await assessReadiness(input);
    assert.equal(report.ready, true, cloud + ": " + JSON.stringify(report.checks.filter((c) => !c.ok)));
    assert.equal(report.next, null);
    // Every item is READY except the advisory financial controls item: with no cost status read it is UNVERIFIED, and it never stops a run.
    assert.ok(report.checks.every((c) => c.responsible === undefined && (c.state === "READY" || (c.advisory === true && c.ok))));
    assert.deepEqual(report.checks.filter((c) => c.advisory).map((c) => [c.check, c.state]), [[FINANCIAL_CHECK, "UNVERIFIED"]]);
  }
});

test("the STATE_WRITE embedding item is Terraform's only: a Terraform contract lists it (yes, the binding is required), one without the binding is INVALID, a CDK contract never lists it, and nothing else differs in what is judged", async () => {
  const embed = (report: ReadinessReport) => report.checks.filter((c) => c.check.startsWith("plan will embed STATE_WRITE settings"));
  const terraform = await assessReadiness((await world((k) => awsContractJson(k), "AWS")).input);
  assert.deepEqual(embed(terraform).map((c) => [c.check, c.state]), [["plan will embed STATE_WRITE settings: yes", "READY"]]);
  // Without the binding (owner decision 6486426552) the contract itself is INVALID, so nothing about the plan is judged as ready.
  const unbound = await assessReadiness((await world((k) => awsContractJson(k, { embedStateWrite: false }), "AWS")).input);
  assert.deepEqual(unbound.checks.map((c) => c.state), ["INVALID"]);
  assert.equal(unbound.ready, false);
  const cdk = await world((k) => cdkContractJson(k), false);
  const report = await assessReadiness({ ...cdk.input, env: cdkIdentityEnv("DEV") });
  assert.deepEqual(embed(report), [], "the CDK engine has no state backend and no STATE_WRITE identity, so the item is not shown");
  // The other checks are the same list for both engines, in the same order: the contract, the identities, their target, the tool, the stop, the qualification.
  const names = (r: ReadinessReport) => r.checks.map((c) => c.check.replace(/\(.*\)/, "").replace(/aws|terraform/, "<tool>").trim());
  assert.deepEqual(names(report), names(terraform).filter((n) => !n.startsWith("plan will embed")));
});

test("an absent contract is MISSING and an unreadable one INVALID, both the owner's, and nothing else is judged", async () => {
  const { input, contractPath } = await world();
  rmSync(contractPath);
  const absent = await assessReadiness(input);
  assert.deepEqual(absent.checks.map((c) => [c.state, c.responsible]), [["MISSING", "OWNER"]]);
  assert.deepEqual(absent.next, { check: absent.checks[0].check, responsible: "OWNER" });
  writeFileSync(contractPath, "{");
  assert.deepEqual((await assessReadiness(input)).checks.map((c) => c.state), ["INVALID"]);
  writeFileSync(contractPath, JSON.stringify({ schemaVersion: 1, enabled: true }));
  const shape = await assessReadiness(input);
  assert.equal(shape.checks.length, 1);
  assert.equal(shape.checks[0].state, "INVALID");
});

test("a missing tool is UNAVAILABLE for the tool installer, and the emergency stop is BLOCKED for the owner", async () => {
  const { input, kill } = await world();
  const noTool = await assessReadiness({ ...input, toolDirs: [fresh("no-tools")] });
  assert.deepEqual([item(noTool, "tool terraform").state, item(noTool, "tool terraform").responsible], ["UNAVAILABLE", "TOOL"]);
  writeFileSync(kill, "stop");
  const stopped = await assessReadiness(input);
  assert.deepEqual([item(stopped, "kill switch").state, item(stopped, "kill switch").responsible], ["BLOCKED", "OWNER"]);
  assert.equal(stopped.ready, false);
});

test("no qualification is MISSING and leaves the backend attestation UNVERIFIED; evidence for another binary is INVALID", async () => {
  const unqualified = await assessReadiness((await world(undefined, false)).input);
  assert.equal(item(unqualified, "engine qualified").state, "MISSING");
  assert.match(item(unqualified, "engine qualified").detail ?? "", /\.\/alz apply qualify/);
  assert.equal(item(unqualified, "identity separation attested").state, "UNVERIFIED");
  assert.deepEqual(unqualified.next, { check: item(unqualified, "engine qualified").check, responsible: "OWNER" });

  const { input } = await world();
  const otherTools = fresh("other-tools");
  installFakeTerraform(otherTools);
  writeFileSync(join(otherTools, "terraform"), readFileSync(join(otherTools, "terraform"), "utf8") + "\n// another build\n", { mode: 0o755 });
  const changed = await assessReadiness({ ...input, toolDirs: [otherTools] });
  assert.equal(item(changed, "engine qualified").state, "INVALID");
  assert.match(item(changed, "engine qualified").detail ?? "", /this engine binary/);
});

test("sign-ins aimed at another environment's account are INVALID for the operator, and the next step is that, not anything after it", async () => {
  const { input } = await world();
  const wrong = await assessReadiness({ ...input, env: identityEnv("QA") });
  assert.equal(item(wrong, "identities aimed at the DEV account").state, "INVALID");
  assert.equal(item(wrong, "identities aimed at the DEV account").responsible, "OPERATOR");
  // The first item that is not ready, in journey order: never a later one, never "seal".
  const firstBad = wrong.checks.find((c) => !c.ok)!;
  assert.deepEqual(wrong.next, { check: firstBad.check, responsible: firstBad.responsible });
  const none = await assessReadiness({ ...input, env: {} });
  assert.equal(item(none, "identities configured").state, "MISSING");
  assert.equal(none.next?.check, item(none, "identities configured").check, "a missing sign-in comes before the target check it makes impossible");
});

test("an environment other than DEV, QA or PROD is refused, and readiness grants nothing: it reaches no engine, driver, seal, approval or ledger", async () => {
  const { input } = await world();
  await assert.rejects(() => assessReadiness({ ...input, environment: "STAGING" as never }), /READINESS_ENVIRONMENT_INVALID/);
  const source = readFileSync(fileURLToPath(new URL("../src/apply/readiness.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /child_process|\bspawn\b|\bexecFile\b/);
  for (const banned of ["./driver.js", "./seal.js", "./approval.js", "./ledger.js", "./engines/", "../cli/"]) assert.ok(!source.includes('from "' + banned), banned);
});

// --- the advisory financial controls item (plan item 5): a real state from the saved cost status, never a stop ---------------

const AWS_CONTRACT = { provider: "AWS", targets: { DEV: { accountId: "111111111111" } } } as unknown as PilotContract;
const READ_AT = new Date("2026-10-31T13:00:00Z");

test("financial controls: each cost status maps to an honest readiness state, and none is a stop", async () => {
  const expected: Record<CostVariant, string> = { observed: "READY", waiting: "UNVERIFIED", stale: "UNAVAILABLE", incomplete: "UNAVAILABLE", attention: "INVALID", missing: "MISSING" };
  for (const [variant, state] of Object.entries(expected) as [CostVariant, string][]) {
    const status = await costStatusOf(variant);
    const at = variant === "stale" ? new Date(Date.parse(status.capturedAt) + 3_600_000) : READ_AT;
    const result = costReadiness({ state: "OK", status }, AWS_CONTRACT, "DEV", at);
    assert.equal(result.state, state, variant + ": " + result.detail);
    assert.doesNotMatch(result.detail, /111111111111|finops@example\.com/, "names, never values");
  }
  assert.match(costReadiness({ state: "OK", status: await costStatusOf("observed") }, AWS_CONTRACT, "DEV", READ_AT).detail, /never caps spend/);
  assert.match(costReadiness({ state: "OK", status: await costStatusOf("waiting") }, AWS_CONTRACT, "DEV", READ_AT).detail, /No data yet is not zero spend/);
  assert.match(costReadiness({ state: "OK", status: await costStatusOf("attention") }, AWS_CONTRACT, "DEV", READ_AT).detail, /an alert has no recipient/);
});

test("financial controls: nothing read, an unreadable file, another account, an old read or a non-AWS contract is UNVERIFIED", async () => {
  const status = await costStatusOf("observed");
  assert.match(costReadiness({ state: "NONE" }, AWS_CONTRACT, "DEV", READ_AT).detail, /No cost status has been read.*\.\/alz cost status/);
  assert.equal(costReadiness({ state: "UNREADABLE" }, AWS_CONTRACT, "DEV", READ_AT).state, "UNVERIFIED");
  assert.equal(costReadiness({ state: "OK", status: { ...status, accountId: "222222222222" } }, AWS_CONTRACT, "DEV", READ_AT).state, "UNVERIFIED");
  assert.equal(costReadiness({ state: "OK", status }, AWS_CONTRACT, "QA", READ_AT).state, "UNVERIFIED", "no QA target: not this environment's account");
  const late = new Date(Date.parse(status.capturedAt) + (COST_STATUS_MAX_AGE_HOURS + 1) * 3_600_000);
  assert.match(costReadiness({ state: "OK", status }, AWS_CONTRACT, "DEV", late).detail, /not within the last 24 hours/);
  assert.equal(costReadiness({ state: "OK", status }, { ...AWS_CONTRACT, provider: "AZURE" } as PilotContract, "DEV", READ_AT).state, "UNVERIFIED");
});

test("financial controls through assessReadiness: a saved observed status for the DEV account is READY, advisory, and an attention status never blocks", async () => {
  const { input } = await world((k) => awsContractJson(k), "AWS");
  for (const [variant, state] of [["observed", "READY"], ["missing", "MISSING"]] as const) {
    writeCostSnapshot({ ...(await costStatusOf(variant)), capturedAt: NOW.toISOString() }, input.costStatusPath!);
    const report = await assessReadiness(input);
    const financial = item(report, "financial controls");
    assert.deepEqual([financial.state, financial.ok, financial.advisory, financial.responsible], [state, true, true, undefined]);
    assert.equal(report.ready, true, "the financial item never stops a run");
    assert.equal(report.next, null);
  }
});

test("B2: a shallow or malformed saved status never throws and is never READY: UNVERIFIED through assessReadiness, still advisory", async () => {
  const { input } = await world((k) => awsContractJson(k), "AWS");
  const shallow = (overall: string) => ({ kind: "ALZ_COST_STATUS", source: "AWS_API_READ_ONLY", accountId: "111111111111", capturedAt: NOW.toISOString(), overall,
    advisory: true, actEnabled: false, budget: { state: "PRESENT", hardSpendCap: false }, tags: { state: "x" }, costAllocationTags: { state: "x" }, export: { state: "x" }, freshness: { state: "x" } });
  const observed = { ...(await costStatusOf("observed")), capturedAt: NOW.toISOString() };
  for (const content of [
    { schemaVersion: 1, kind: "ALZ_COST_STATUS_SNAPSHOT", status: shallow("OBSERVED_COMPLETE") },
    { schemaVersion: 1, kind: "ALZ_COST_STATUS_SNAPSHOT", status: shallow("ATTENTION") },
    { schemaVersion: 2, kind: "ALZ_COST_STATUS_SNAPSHOT", status: observed },
    observed,
  ]) {
    writeFileSync(input.costStatusPath!, JSON.stringify(content));
    const report = await assessReadiness(input);
    const financial = item(report, "financial controls");
    assert.deepEqual([financial.state, financial.ok, financial.advisory], ["UNVERIFIED", true, true], JSON.stringify(content).slice(0, 80));
    assert.equal(report.ready, true);
  }
  // A directory where the file should be is unreadable, not a throw.
  rmSync(input.costStatusPath!, { force: true });
  mkdirSync(input.costStatusPath!);
  assert.equal(item(await assessReadiness(input), "financial controls").state, "UNVERIFIED");
  // costReadiness itself is total: handed a malformed status directly, it answers UNVERIFIED.
  const malformed = costReadiness({ state: "OK", status: { ...shallow("ATTENTION"), capturedAt: READ_AT.toISOString() } as never }, AWS_CONTRACT, "DEV", READ_AT);
  assert.deepEqual(malformed.state, "UNVERIFIED");
  assert.match(malformed.detail, /could not be judged/, "reached the judgment and was caught there, not refused earlier");
  assert.equal(costReadiness({ state: "OK", status: null as never }, AWS_CONTRACT, "DEV", READ_AT).state, "UNVERIFIED");
});
