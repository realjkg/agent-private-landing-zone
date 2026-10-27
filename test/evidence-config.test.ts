import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadConfig, parseConfig } from "../src/evidence-runner/config.js";
import { CANDIDATE, fixtureRoot, validConfig, writeConfig } from "./helpers/evidence-fixtures.js";

// SYNTHETIC: the evidence runner's configuration names identifiers only. These tests pin the closed key set, the
// refused placeholders and credential-shaped values, and that a refusal never echoes the value it refused.

const problems = (value: unknown): string[] => {
  const result = parseConfig(value);
  return result.ok ? [] : result.problems;
};

test("a filled-in configuration is accepted with its defaults", () => {
  const result = parseConfig(validConfig({ evidenceDir: undefined, modelHost: undefined }));
  assert.ok(result.ok);
  assert.equal(result.config.evidenceDir, ".runs/evidence");
  assert.equal(result.config.modelHost, false);
  assert.equal(result.config.candidateCommit, CANDIDATE);
  assert.deepEqual(parseConfig(validConfig({ aws: undefined, azure: undefined })).ok, true, "both provider blocks are optional");
});

test("the committed example is refused until every placeholder is replaced", () => {
  const example = JSON.parse(readFileSync("config/evidence-runner.example.json", "utf8")) as unknown;
  assert.match(problems(example).join("\n"), /REPLACE-WITH placeholders/);
});

test("unknown keys, a gcp block and credential-bearing keys are refused by name", () => {
  assert.match(problems(validConfig({ awsProfile: "dev" })).join(), /config\.awsProfile: unknown key/);
  assert.match(problems(validConfig({ aws: { ...validConfig().aws as object, profile: "dev" } })).join(), /config\.aws\.profile: unknown key/);
  assert.match(problems(validConfig({ azure: { ...validConfig().azure as object, clientSecret: "x" } })).join(), /config\.azure\.clientSecret: unknown key/);
  assert.match(problems(validConfig({ gcp: { expectedProjectId: "p" } })).join(), /GCP joins in slice S4/);
});

test("malformed identifiers are refused without echoing the value", () => {
  const secret = "AKIAABCDEFGHIJKLMNOP";
  const found = problems(validConfig({ candidateCommit: "abc", targetHardwareId: secret, aws: { expectedAccountId: "12", region: "Mars", qualificationStack: "1bad" },
    azure: { expectedTenantId: "not-a-guid", expectedSubscriptionId: "ZZ", location: "West Europe" } }));
  for (const field of ["candidateCommit", "targetHardwareId", "aws.expectedAccountId", "aws.region", "aws.qualificationStack", "azure.expectedTenantId", "azure.expectedSubscriptionId", "azure.location"]) {
    assert.ok(found.some((problem) => problem.startsWith("config." + field + ":")), field);
  }
  assert.ok(!found.join("\n").includes(secret), "a refused value is never echoed");
  assert.match(found.join(), /targetHardwareId: looks like a credential/);
  assert.match(problems(validConfig({ targetHardwareId: "eyJhbGciOi" })).join(), /looks like a credential/);
});

test("the evidence folder must stay inside the repository", () => {
  for (const evidenceDir of ["/tmp/evidence", "../outside", ".runs/../../x", ""]) {
    assert.match(problems(validConfig({ evidenceDir })).join(), /evidenceDir: must be a relative path inside the repository/, evidenceDir);
  }
  assert.equal(problems(validConfig({ schemaVersion: 2 })).length, 1);
  assert.match(problems(validConfig({ modelHost: "yes" })).join(), /modelHost/);
});

test("loadConfig binds the exact bytes and refuses a path outside the repository or a missing file", () => {
  const root = fixtureRoot();
  writeConfig(root, validConfig());
  const loaded = loadConfig(root);
  assert.ok(loaded.ok);
  assert.match(loaded.sha256, /^[0-9a-f]{64}$/);
  writeConfig(root, validConfig({ targetHardwareId: "owner-mac-02" }));
  const changed = loadConfig(root);
  assert.ok(changed.ok && changed.sha256 !== loaded.sha256, "another configuration is another run");
  assert.deepEqual(loadConfig(root, "../escape.json"), { ok: false, problems: ["--config: must be a file inside the repository"] });
  assert.match((loadConfig(root, "config/missing.json") as { problems: string[] }).problems.join(), /Run \.\/alz evidence init/);
});
