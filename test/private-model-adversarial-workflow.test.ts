import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/model-qualification.yml", "utf8");

test("only dedicated labeled private runner executes model attack corpus", () => {
  const start = workflow.indexOf("  production-target:");
  const end = workflow.indexOf("  qwen3-8b:", start);
  assert.ok(start >= 0 && end > start);
  const section = workflow.slice(start, end);
  assert.match(section, /runs-on: \[self-hosted, linux, alz-private-model\]/);
  assert.match(section, /OLLAMA_BASE_URL: http:\/\/127\.0\.0\.1:11435/);
  assert.match(section, /Attest private target and installed model digests/);
  assert.match(section, /Adversarial smoke on all three private models/);
  assert.match(section, /node dist\/cli\/private-model-adversarial\.js --scope first/);
  assert.ok(section.indexOf("Qualify production target") <
    section.indexOf("Adversarial smoke on all three private models"));
  assert.ok(section.indexOf("Compile source-bound agent runtime") <
    section.indexOf("Adversarial smoke on all three private models"));
  assert.doesNotMatch(section, /terraform apply|pulumi up|cdk deploy|aws iam create/);
});

test("full model corpus remains explicit, auditable and retained", () => {
  assert.match(workflow, /adversarial_scope:/);
  assert.match(workflow, /default: first/);
  assert.match(workflow, /adversarial_scope == 'all'/);
  assert.match(workflow, /node dist\/cli\/private-model-adversarial\.js --scope all/);
  assert.match(workflow, /\.runs\/qualification\/private-model-adversarial\/\*\.json/);
  assert.match(workflow, /\.runs\/qualification\/private-model-adversarial\/\*\.csv/);
});
