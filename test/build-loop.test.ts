import assert from "node:assert/strict";
import test from "node:test";

import { runBuildLoop } from "../src/build/loop.js";

test("brownfield Terraform build stops before approval", async () => {
  const result = await runBuildLoop({
    provider: "AWS",
    engine: "TERRAFORM",
    mock: "brownfield",
  });

  assert.equal(
    result.candidate.environment.safeBuildMode,
    "ADDITIVE_ONLY",
  );
  assert.equal(result.executionMode, "PREVIEW_ONLY");
  assert.equal(result.gate.allowed, false);
  assert.match(
    result.gate.reasons.join(" "),
    /approval/i,
  );
});

test("approved Azure Pulumi fixture passes gate without apply", async () => {
  const result = await runBuildLoop({
    provider: "AZURE",
    engine: "PULUMI",
    mock: "greenfield",
    approve: true,
  });

  assert.equal(result.gate.allowed, true);
  assert.equal(result.executionMode, "PREVIEW_ONLY");
  assert.equal(
    result.previewSummary.includes("delete=0"),
    true,
  );
});

test("unknown environment remains blocked", async () => {
  const result = await runBuildLoop({
    provider: "AWS",
    engine: "PULUMI",
    mock: "unknown",
    approve: true,
  });

  assert.equal(result.gate.allowed, false);
  assert.match(
    result.gate.reasons.join(" "),
    /UNKNOWN|READ_ONLY/,
  );
});
