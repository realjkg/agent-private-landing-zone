import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { assessEnvironment } from "../src/assessment/posture.js";
import { createDesignSpec } from "../src/design/create.js";
import { calculateDesignContentHash,
  evaluateDesignBuildHandoff } from "../src/design/handoff.js";
import { assessDelta } from "../src/delta/assess.js";
import { discoverEnvironment } from "../src/discovery/discover.js";

async function makeDesign(provider: "AWS" | "AZURE" = "AWS",
  engine: "TERRAFORM" | "BICEP" | "CLOUDFORMATION" | "PULUMI" = "TERRAFORM",
  estate: "brownfield" | "greenfield" | "unknown" = "brownfield",
  includeAdd = true) {
  const environment = await discoverEnvironment({ provider, mock: estate });
  const assessment = assessEnvironment(environment);
  const delta = assessDelta(environment, "Build a bounded preview.");
  if (includeAdd) {
    delta.decisions.push({
      resourceId: "new:approved:single-resource",
      resourceType: "managed_configuration",
      action: "ADD", reason: "Explicit DesignSpec resource entry",
      requiresExplicitAuthorization: true,
    });
  }
  const design = createDesignSpec({
    environment, assessment, delta,
    objective: "Build a bounded preview.", constraints: ["No ACT"],
    engine,
  });
  return { design, environment };
}

test("design hash and handoff retain the complete reviewable ownership/policy scope", async () => {
  const { design, environment } = await makeDesign();
  assert.equal(calculateDesignContentHash(design), design.designHash);
  const result = evaluateDesignBuildHandoff({
    provider: "AWS", engine: "TERRAFORM", environment, design,
  });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.status, "REVIEW_REQUIRED");
  assert.equal(result.discoveryMode, "SYNTHETIC");
  assert.deepEqual(result.blockers, []);
  assert.equal(result.infrastructureAct, "DISABLED");
  assert.equal(result.policyHash, design.policies.bundleHash);
  assert.equal(result.designHash, design.designHash);
  assert.equal(result.resourceActions.at(-1)?.action, "ADD");
  assert.match(result.handoffHash, /^[a-f0-9]{64}$/);
  assert.match(result.environmentHash, /^[a-f0-9]{64}$/);
  const repeated = evaluateDesignBuildHandoff({
    provider: "AWS", engine: "TERRAFORM", environment, design,
  });
  assert.equal(result.handoffHash, repeated.handoffHash);
});

test("missing explicit ADD intent is REVIEW_REQUIRED, never invented by BUILD", async () => {
  const { design, environment } = await makeDesign("AWS", "TERRAFORM", "brownfield", false);
  const packet = evaluateDesignBuildHandoff({
    provider: "AWS", engine: "TERRAFORM", design, environment,
  });
  assert.equal(packet.status, "REVIEW_REQUIRED");
  assert.ok(packet.reviewRequired.includes("EXPLICIT_ADD_RESOURCE_DESIGN_REQUIRED"));
});

test("tampering policy, delta, approval status, evidence and intent fails integrity", async () => {
  const { design, environment } = await makeDesign();
  for (const changed of [
    { ...design, objective: design.objective + " ADD ADMIN ROLE" },
    { ...design, additions: ["unapproved:add"] },
    { ...design, forbiddenChanges: [] },
    { ...design, policies: { ...design.policies, bundleHash: "f".repeat(64) } },
    { ...design, evidenceRefs: [] },
    { ...design, status: "PROPOSED" as const },
  ]) {
    const check = evaluateDesignBuildHandoff({
      provider: "AWS", engine: "TERRAFORM", environment, design: changed,
    });
    assert.equal(check.status, "BLOCKED");
    assert.ok(check.blockers.includes("DESIGN_CONTENT_HASH_MISMATCH"));
  }
});

test("a recomputed digest does not excuse a forbidden or undeclared addition", async () => {
  const { design, environment } = await makeDesign();
  const changed = {
    ...design, forbiddenChanges: [...design.forbiddenChanges,
      "new:approved:single-resource"],
  };
  changed.designHash = calculateDesignContentHash(changed);
  const check = evaluateDesignBuildHandoff({
    provider: "AWS", engine: "TERRAFORM", environment, design: changed,
  });
  assert.equal(check.status, "BLOCKED");
  assert.ok(check.blockers.includes("FORBIDDEN_RESOURCE_INTENT"));

  const undeclared = { ...design, additions: ["new:unreviewed"] };
  undeclared.designHash = calculateDesignContentHash(undeclared);
  const missing = evaluateDesignBuildHandoff({
    provider: "AWS", engine: "TERRAFORM", environment, design: undeclared,
  });
  assert.equal(missing.status, "BLOCKED");
  assert.ok(missing.blockers.includes("DESIGN_RESOURCE_ACTION_LIST_MISMATCH"));
});

test("Azure CloudFormation is incompatible and not executed", async () => {
  const { design, environment } = await makeDesign("AZURE", "CLOUDFORMATION");
  const packet = evaluateDesignBuildHandoff({
    provider: "AZURE", engine: "CLOUDFORMATION", design, environment,
  });
  assert.equal(packet.status, "BLOCKED");
  assert.ok(packet.blockers.includes("UNSUPPORTED_OR_UNAVAILABLE_BUILD_ADAPTER"));
});

test("CloudFormation greenfield is Design-only even with a synthetic ADD entry", async () => {
  const { design, environment } = await makeDesign("AWS", "CLOUDFORMATION", "greenfield");
  const packet = evaluateDesignBuildHandoff({
    provider: "AWS", engine: "CLOUDFORMATION", design, environment,
  });
  assert.equal(packet.status, "BLOCKED");
  assert.ok(packet.blockers.includes("EXISTING_STACK_REQUIRED"));
});

test("unknown estate and unknown resource ownership fail closed", async () => {
  const unknown = await makeDesign("AWS", "TERRAFORM", "unknown");
  assert.equal(evaluateDesignBuildHandoff({
    ...unknown, provider: "AWS", engine: "TERRAFORM",
  }).status, "BLOCKED");
  const { design, environment } = await makeDesign();
  const unsafe = {
    ...environment, resources: environment.resources.map((r, i) =>
      i === 0 ? { ...r, ownership: "UNKNOWN" as const } : r),
  };
  const packet = evaluateDesignBuildHandoff({
    provider: "AWS", engine: "TERRAFORM", design, environment: unsafe,
  });
  assert.ok(packet.blockers.includes("UNKNOWN_OWNERSHIP_OR_UNSAFE_DISCOVERY"));
});

test("design/estate/provider mismatch fails before typed provider adapter", async () => {
  const { design, environment } = await makeDesign();
  for (const changed of [
    { environment, provider: "AZURE" as const },
    { environment: { ...environment, classification: "GREENFIELD" as const },
      provider: "AWS" as const },
  ]) {
    const packet = evaluateDesignBuildHandoff({
      design, engine: "TERRAFORM", ...changed,
    });
    assert.equal(packet.status, "BLOCKED");
    assert.ok(packet.blockers.includes("PROVIDER_OR_ESTATE_MISMATCH"));
  }
});

test("current ARM64 runtime compose keeps no privilege escalation and does not prove local Ollama connectivity", () => {
  const compose = readFileSync("compose.yaml", "utf8");
  assert.match(compose, /read_only:\s*true/);
  assert.match(compose, /cap_drop:\s*\n\s*- ALL/);
  assert.match(compose, /no-new-privileges:true/);
  assert.doesNotMatch(compose, /privileged:\s*true|network_mode:\s*host/);
  // This test is a static deployment-contract check, NOT a network probe.
  assert.ok(!/OLLAMA_BASE_URL:/.test(compose));
});
