import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const result = parseConfig(validConfig({ evidenceDir: undefined }));
  assert.ok(result.ok);
  assert.equal(result.config.evidenceDir, ".runs/evidence");
  assert.equal(result.config.candidateCommit, CANDIDATE);
  assert.deepEqual(parseConfig(validConfig({ aws: undefined, azure: undefined })).ok, true, "both provider blocks are optional");
});

test("the committed example is refused until every placeholder is replaced", () => {
  const example = JSON.parse(readFileSync("config/evidence-runner.example.json", "utf8")) as unknown;
  assert.match(problems(example).join("\n"), /REPLACE-WITH placeholders/);
});

test("unknown keys and credential-bearing keys are refused by name, in every block", () => {
  assert.match(problems(validConfig({ awsProfile: "dev" })).join(), /config\.awsProfile: unknown key/);
  assert.match(problems(validConfig({ aws: { ...validConfig().aws as object, profile: "dev" } })).join(), /config\.aws\.profile: unknown key/);
  assert.match(problems(validConfig({ azure: { ...validConfig().azure as object, clientSecret: "x" } })).join(), /config\.azure\.clientSecret: unknown key/);
  assert.match(problems(validConfig({ gcp: { expectedProjectId: "alz-dev-pilot", region: "europe-west1", credentialsFile: "/x.json" } })).join(), /config\.gcp\.credentialsFile: unknown key/);
  assert.match(problems(validConfig({ act: { repository: "o/r", paths: {}, token: "x" } })).join(), /config\.act\.token: unknown key/);
  assert.match(problems(validConfig({ act: { repository: "o/r", paths: { "aws-terraform": { project: "/p", requesterId: "a", keyFile: "/k.pem" } } } })).join(),
    /config\.act\.paths\.aws-terraform\.keyFile: unknown key \(key files are asked for at the terminal, never stored\)/);
});

test("the gcp block names a project and region; the act block names a repository and, per known path, an absolute project folder and people's ids", () => {
  const act = { repository: "realjkg/agent-private-landing-zone", paths: { "aws-terraform": { project: "/Users/owner/act-dev1-aws", requesterId: "owner@example", approverId: "approver-1" }, "gcp-terraform": { project: "/srv/canary/gcp", requesterId: "owner" } } };
  const result = parseConfig(validConfig({ gcp: { expectedProjectId: "alz-dev-pilot", region: "europe-west1" }, act }));
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.config.gcp?.expectedProjectId, "alz-dev-pilot");
  assert.equal(result.config.act?.paths["aws-terraform"]?.approverId, "approver-1");
  const found = problems(validConfig({
    gcp: { expectedProjectId: "Bad_Project", region: "mars" },
    act: { repository: "no-slash", paths: { "aws-everything": { project: "/p", requesterId: "a" }, "aws-cdk": { project: "relative/dir", requesterId: "a b" }, "azure-bicep": { project: "/a/../b", requesterId: "x" } } },
  }));
  for (const expected of ["config.gcp.expectedProjectId:", "config.gcp.region:", "config.act.repository:", "config.act.paths.aws-everything: unknown path",
    "config.act.paths.aws-cdk.project:", "config.act.paths.aws-cdk.requesterId:", "config.act.paths.azure-bicep.project:"]) {
    assert.ok(found.some((problem) => problem.startsWith(expected)), expected + " in " + found.join(" | "));
  }
  assert.match(problems(validConfig({ act: { repository: "o/r", paths: { "aws-terraform": { project: "/p", requesterId: "AKIAABCDEFGHIJKLMNOP" } } } })).join(), /requesterId: looks like a credential/);
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

test("the evidence folder is .runs/evidence or a folder under it, never another repository folder", () => {
  for (const evidenceDir of ["/tmp/evidence", "../outside", ".runs/../../x", "", ".", "./", "src", "docs", ".git", ".runs", ".runs/evidence-other",
    ".runs/evidence/../x", ".runs/evidence/./x", ".runs\\evidence", ".runs//evidence"]) {
    assert.match(problems(validConfig({ evidenceDir })).join(), /evidenceDir: must be \.runs\/evidence or a folder under it/, JSON.stringify(evidenceDir));
  }
  for (const evidenceDir of [".runs/evidence", ".runs/evidence/", ".runs/evidence/owner-mac"]) assert.deepEqual(problems(validConfig({ evidenceDir })), [], evidenceDir);
  assert.equal(problems(validConfig({ schemaVersion: 2 })).length, 1);
  assert.match(problems(validConfig({ modelHost: true })).join(), /config\.modelHost: unknown key/, "the model host flag is not part of this build");
});

test("a symbolic link anywhere on the evidence path is refused before anything is written", () => {
  for (const linked of [".runs", ".runs/evidence"]) {
    const root = fixtureRoot();
    const outside = mkdtempSync(join(tmpdir(), "alz-evidence-outside-"));
    mkdirSync(join(root, linked, ".."), { recursive: true });
    symlinkSync(outside, join(root, linked));
    writeConfig(root, validConfig());
    const loaded = loadConfig(root);
    assert.equal(loaded.ok, false, linked);
    assert.match((loaded as { problems: string[] }).problems.join(), /is a symbolic link/, linked);
    assert.deepEqual(readdirSync(outside), [], "nothing was written through the link");
  }
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
