import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/model-qualification.yml", "utf8");

test("production target only runs on labeled, isolated private-model hardware", () => {
  assert.match(workflow, /runs-on: \[self-hosted, linux, alz-private-model\]/);
  assert.match(workflow, /OLLAMA_HOST: 127\.0\.0\.1:11435/);
  assert.match(workflow, /--target-hardware-id/);
  assert.match(workflow, /production-target-preflight\.json/);
});
test("real Qwen and Mistral agent first-scenario qualification is mandatory", () => {
  const start = workflow.indexOf("  production-target:");
  const end = workflow.indexOf("  qwen3-8b:", start);
  assert.ok(start >= 0 && end > start);
  const job = workflow.slice(start, end);
  assert.match(job, /Qualify production target/);
  assert.match(job, /node dist\/cli\/qualify-aws-terraform-agent\.js --live-models --terraform-validate/);
  assert.match(job, /command -v terraform/);
  assert.ok(job.indexOf("production-target-preflight.json") <
    job.indexOf("Qualify first Qwen/Mistral AWS Terraform agent loop"));
  assert.ok(job.indexOf("Qualify production target") <
    job.indexOf("Qualify first Qwen/Mistral AWS Terraform agent loop"));
  assert.doesNotMatch(job, /ollama pull|terraform apply|terraform destroy|pulumi up/);
});
test("the costly eight-scenario model run requires explicit operator selection", () => {
  assert.match(workflow, /live_scenario_scope:/);
  assert.match(workflow, /default: first/);
  assert.match(workflow, /live_scenario_scope == 'all'/);
  assert.match(workflow, /node dist\/cli\/private-agent-matrix\.js --live-models/);
  assert.match(workflow, /\.runs\/qualification\/private-agent-matrix\/\*\.json/);
});
