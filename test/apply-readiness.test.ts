import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assessReadiness, type ReadinessInput, type ReadinessReport } from "../src/apply/readiness.js";
import { cdkContractJson, cdkIdentityEnv } from "./helpers/cdk-fixtures.js";
import {
  awsContractJson, awsIdentityEnv, contractJson, identityEnv, installFakeTerraform, NOW, pinPathOf, testFixtureForgeQualificationEvidence, writePinnedContract,
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
  writePinnedContract(contractPath, contract(kill));
  const vault = join(dir, "vault");
  mkdirSync(vault);
  if (qualified) await testFixtureForgeQualificationEvidence(vault, undefined, qualified);
  const input: ReadinessInput = {
    environment: "DEV", contractPath, contractPinPath: pinPathOf(contractPath), qualificationDir: vault, toolDirs: [toolDir],
    env: qualified === "AWS" ? awsIdentityEnv("DEV") : identityEnv("DEV"), now: () => NOW,
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
    assert.ok(report.checks.every((c) => c.state === "READY" && c.responsible === undefined));
  }
});

test("the STATE_WRITE embedding item is Terraform's only: a Terraform contract lists it (yes or no), a CDK contract never does, and nothing else differs in what is judged", async () => {
  const embed = (report: ReadinessReport) => report.checks.filter((c) => c.check.startsWith("plan will embed STATE_WRITE settings"));
  const terraform = await assessReadiness((await world((k) => awsContractJson(k), "AWS")).input);
  assert.deepEqual(embed(terraform).map((c) => [c.check, c.state]), [["plan will embed STATE_WRITE settings: no", "READY"]]);
  const optedIn = await assessReadiness((await world((k) => awsContractJson(k, { embedStateWrite: true }), "AWS")).input);
  assert.deepEqual(embed(optedIn).map((c) => c.check), ["plan will embed STATE_WRITE settings: yes"]);
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
