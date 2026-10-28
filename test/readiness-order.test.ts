import assert from "node:assert/strict";
import test from "node:test";

import type { DeploymentPath, EnvironmentDecision } from "../src/operator-ui/app/pilot/pilot-api.js";
import { badgeOf, checkedTime, environmentReady, firstSentence, orderByReadiness, orderEnvironments, tierOf } from "../src/operator-ui/app/pilot/readiness-order.js";

// The console's readiness-first ordering (owner decision E5). Pure functions over fixture data (SYNTHETIC); nothing here reads
// a record, a contract or a cloud.

const decision = (environment: EnvironmentDecision["environment"], over: Partial<EnvironmentDecision> = {}): EnvironmentDecision => ({
  environment, authorized: true, operations: ["APPLY", "CLEANUP"], ready: true, notReady: [], approved: true, requiredApprovals: 1, checkedAt: "t", ...over,
});
const owner = (text: string) => ({ party: "OWNER" as const, source: "GATE", text });
const path = (cloud: string, engine: string, over: Partial<DeploymentPath> = {}): DeploymentPath => ({
  cloud, engine, label: cloud + " " + engine, inRelease: true, liveStatus: "BLOCKED", journeyStatus: "SYNTHETIC_PASS", implemented: true, actGate: null,
  blockers: [owner("A live run by the owner.")], isContractPath: false, ...over,
});
const keys = (paths: readonly Partial<DeploymentPath>[]) => paths.map((p) => p.cloud + "/" + p.engine);

test("tier 1: only the contract's path with an environment that is Authorized, Ready and Approved", () => {
  const ready = path("AZURE", "TERRAFORM", { isContractPath: true, decisions: [decision("DEV"), decision("QA", { ready: null })] });
  assert.deepEqual(tierOf(ready), { tier: 1, outstanding: 1 });
  for (const missing of [{ authorized: false }, { ready: false }, { ready: null }, { approved: false }] as Partial<EnvironmentDecision>[]) {
    const almost = path("AZURE", "TERRAFORM", { isContractPath: true, decisions: [decision("DEV", missing)] });
    assert.notEqual(tierOf(almost).tier, 1, JSON.stringify(missing));
  }
  // The same decisions on a path that is not the contract's are not readiness.
  assert.equal(tierOf(path("AWS", "TERRAFORM", { isContractPath: false, decisions: [decision("DEV")] })).tier, 2);
});

test("tier 2: implemented and in release with only people's inputs outstanding; fewer blockers first", () => {
  const one = path("AZURE", "TERRAFORM", { blockers: [owner("Owner inputs.")] });
  const two = path("AWS", "TERRAFORM", { blockers: [owner("Owner inputs."), { party: "OPERATOR", source: "GATE", text: "Install the tool." }] });
  assert.deepEqual(tierOf(one), { tier: 2, outstanding: 1 });
  assert.deepEqual(tierOf(two), { tier: 2, outstanding: 2 });
  assert.deepEqual(keys(orderByReadiness([two, one])), ["AZURE/TERRAFORM", "AWS/TERRAFORM"], "fewer outstanding blockers come first, before the cloud tie-break");
});

test("tier 3: engineering or qualification remains, the row is not implemented, or the blockers are unknown", () => {
  assert.equal(tierOf(path("AWS", "CDK", { blockers: [owner("x"), { party: "ENGINEERING", source: "GATE", text: "Qualify." }] })).tier, 3);
  assert.equal(tierOf(path("AWS", "CDK", { blockers: [{ party: "QUALIFICATION", source: "GATE", text: "CI." }] })).tier, 3);
  assert.equal(tierOf(path("AZURE", "BICEP", { implemented: false, journeyStatus: "BLOCKED" })).tier, 3);
  assert.equal(tierOf({ ...path("AWS", "TERRAFORM"), blockers: undefined } as unknown as DeploymentPath).tier, 3);
});

test("tier 4: not in this release, or not implemented", () => {
  assert.equal(tierOf(path("GCP", "TERRAFORM", { inRelease: false })).tier, 4);
  assert.equal(tierOf(path("AWS", "TERRAFORM", { journeyStatus: "NOT_IMPLEMENTED" })).tier, 4);
  // Even a READY-looking contract path outside the release is not ready.
  assert.equal(tierOf(path("GCP", "TERRAFORM", { inRelease: false, isContractPath: true, decisions: [decision("DEV")] })).tier, 4);
});

test("unknown or malformed data is never READY", () => {
  for (const unknown of [undefined, null, {}, { isContractPath: true }, { inRelease: true, isContractPath: true, decisions: "READY" },
    { inRelease: "true", isContractPath: true, decisions: [decision("DEV")], blockers: [] },
    { inRelease: true, isContractPath: "yes", decisions: [decision("DEV")], blockers: [] },
    { inRelease: true, isContractPath: true, decisions: [{ environment: "DEV", authorized: "true", ready: 1, approved: true }], blockers: [] }]) {
    assert.notEqual(tierOf(unknown as Partial<DeploymentPath>).tier, 1, JSON.stringify(unknown));
  }
  assert.equal(environmentReady(undefined), false);
  assert.equal(environmentReady({ authorized: true, ready: true }), false);
});

test("ties keep a stable order: cloud (AWS, Azure, GCP), then engine (Terraform first), then the order given", () => {
  const given = [path("GCP", "NATIVE_API", { inRelease: false }), path("AZURE", "BICEP"), path("GCP", "TERRAFORM", { inRelease: false }), path("AWS", "CDK"), path("AZURE", "TERRAFORM"), path("AWS", "TERRAFORM")];
  assert.deepEqual(keys(orderByReadiness(given)), ["AWS/TERRAFORM", "AWS/CDK", "AZURE/TERRAFORM", "AZURE/BICEP", "GCP/TERRAFORM", "GCP/NATIVE_API"]);
  assert.deepEqual(keys(orderByReadiness([...given].reverse())), keys(orderByReadiness(given)), "the result does not depend on the order given");
  const twins = [path("AWS", "TERRAFORM", { label: "first" }), path("AWS", "TERRAFORM", { label: "second" })];
  assert.deepEqual(orderByReadiness(twins).map((p) => p.label), ["first", "second"]);
  assert.deepEqual(given.map((p) => p.cloud), ["GCP", "AZURE", "GCP", "AWS", "AZURE", "AWS"], "the input is not changed");
});

test("the release records' shape today: Azure Terraform READY in DEV goes first; GCP last; CDK and Bicep behind the owner-blocked paths", () => {
  const paths = [
    path("AWS", "TERRAFORM", { blockers: [owner("live"), owner("gate")] }),
    path("AWS", "CDK", { blockers: [owner("live"), { party: "ENGINEERING", source: "GATE", text: "qualify" }] }),
    path("AZURE", "TERRAFORM", { blockers: [owner("live"), owner("gate")], isContractPath: true, decisions: [decision("DEV"), decision("QA", { ready: null })] }),
    path("AZURE", "BICEP", { implemented: false, journeyStatus: "BLOCKED", blockers: [{ party: "ENGINEERING", source: "JOURNEY", text: "ui" }] }),
    path("GCP", "TERRAFORM", { inRelease: false, journeyStatus: "NOT_IMPLEMENTED" }),
    path("GCP", "NATIVE_API", { inRelease: false, journeyStatus: "NOT_IMPLEMENTED" }),
  ];
  assert.deepEqual(keys(orderByReadiness(paths)), ["AZURE/TERRAFORM", "AWS/TERRAFORM", "AWS/CDK", "AZURE/BICEP", "GCP/TERRAFORM", "GCP/NATIVE_API"]);
});

test("environments: READY first, then enabled by fewest unmet items (not checked last), then the ones the contract does not enable", () => {
  const order = (d: EnvironmentDecision[]) => orderEnvironments(d).map((c) => c.environment + (c.enabled ? "" : "-off"));
  assert.deepEqual(order([decision("DEV", { ready: null }), decision("QA", { ready: false, notReady: [{ check: "a" }] }), decision("PROD")]), ["PROD", "QA", "DEV"]);
  assert.deepEqual(order([decision("DEV", { ready: false, notReady: [{ check: "a" }, { check: "b" }] }), decision("QA", { ready: false, notReady: [{ check: "a" }] }), decision("PROD", { authorized: false, approved: false })]),
    ["QA", "DEV", "PROD-off"]);
  assert.deepEqual(order([decision("DEV", { authorized: false }), decision("QA", { authorized: false }), decision("PROD", { ready: null })]), ["PROD", "DEV-off", "QA-off"]);
  const off = orderEnvironments([decision("DEV"), decision("QA", { authorized: false, approved: false })]).find((c) => c.environment === "QA")!;
  assert.equal(off.enabled, false);
  assert.match(off.reason, /do not allow changes in QA/);
  // An environment missing from the decisions is not enabled, and never ready.
  const missing = orderEnvironments([decision("DEV")]).find((c) => c.environment === "PROD")!;
  assert.deepEqual([missing.enabled, missing.ready], [false, false]);
});

test("environments without decisions keep today's order, all selectable, none ready", () => {
  for (const unknown of [null, undefined, []]) {
    assert.deepEqual(orderEnvironments(unknown).map((c) => [c.environment, c.enabled, c.ready]), [["DEV", true, false], ["QA", true, false], ["PROD", true, false]]);
  }
});

test("a row shows the first sentence of its first blocker", () => {
  assert.equal(firstSentence("Owner inputs (docs/a.md, What): a contract. Then more."), "Owner inputs (docs/a.md, What): a contract.");
  assert.equal(firstSentence("  No full stop "), "No full stop");
});

test("a path waiting on another path's owner-run live step is still tier 2; a path with unreadable records is tier 3 and says readiness unknown", () => {
  const sequenced = path("AZURE", "TERRAFORM", { blockers: [{ party: "SEQUENCED", source: "JOURNEY", text: "AWS Terraform goes live first." }, owner("Run it.")] });
  assert.equal(tierOf(sequenced).tier, 2);
  assert.equal(badgeOf(sequenced), "Waiting on owner inputs");
  const unknown = path("AWS", "TERRAFORM", { blockers: [{ party: "UNKNOWN", source: "GATE", text: "Readiness unknown: the release status record cannot be read." }, owner("x")] });
  assert.equal(tierOf(unknown).tier, 3);
  assert.equal(badgeOf(unknown), "Readiness unknown");
  assert.equal(badgeOf(path("GCP", "TERRAFORM", { inRelease: false })), "Not in this release");
});

test("a READY environment carries the time of the check that made it ready; others carry none", () => {
  const choices = orderEnvironments([decision("DEV", { checkedAt: "2026-10-28T10:05:00.000Z" }), decision("QA", { ready: null, checkedAt: null })]);
  assert.deepEqual(choices.map((c) => [c.environment, c.checkedAt]), [["DEV", "2026-10-28T10:05:00.000Z"], ["QA", null], ["PROD", null]]);
  assert.match(checkedTime("2026-10-28T10:05:00.000Z"), /\d{1,2}:\d{2}/);
  assert.equal(checkedTime("not a time"), "");
  assert.equal(checkedTime(null), "");
});
