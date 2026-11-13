import assert from "node:assert/strict";
import test from "node:test";

import { formatAwsCosts, parseCostQuestion, tagValue } from "../src/cost/agent-queries.js";
import { operatorReadCredentials } from "../src/cost/operator-credentials.js";
import { classifySessionCommand } from "../src/session/query.js";
import { createSessionGraph } from "../src/session/graph.js";

test("natural-language cost questions map to bounded current-account Cost Explorer dimensions and services", () => {
  assert.deepEqual(parseCostQuestion("How much did KMS and EC2 cost last month by usage type?", new Date("2026-11-03T12:00:00Z")), {
    start: "2026-10-01", end: "2026-11-01", granularity: "MONTHLY", groupBy: ["SERVICE", "USAGE_TYPE"],
    services: ["AWS Key Management Service", "EC2 - Other", "Amazon Elastic Compute Cloud - Compute"],
  });
  assert.deepEqual(parseCostQuestion("Show spend for the last 7 days, grouped by region", new Date("2026-11-03T12:00:00Z")), {
    start: "2026-10-27", end: "2026-11-03", granularity: "DAILY", groupBy: ["SERVICE", "REGION"],
  });
  assert.deepEqual(parseCostQuestion("October 2026 service costs", new Date("2026-11-03T12:00:00Z")), {
    start: "2026-10-01", end: "2026-11-01", granularity: "MONTHLY", groupBy: ["SERVICE"],
  });
  assert.equal(parseCostQuestion("KMS costs in us-east-2 last month", new Date("2026-11-03T12:00:00Z")).region, "us-east-2");
  assert.deepEqual(parseCostQuestion("How much did elastic compute cost last month?").services,
    ["EC2 - Other", "Amazon Elastic Compute Cloud - Compute"]);
  assert.deepEqual(parseCostQuestion("Show EBS snapshot costs").services, ["EC2 - Other"]);
});

test("session routes cost and tag inventory language to the read-only AWS command handlers", () => {
  assert.equal(classifySessionCommand("How much did KMS and EC2 cost last month?", "AWS"), "COST_QUERY");
  assert.equal(classifySessionCommand("Show tagged KMS keys and EC2 volumes", "AWS"), "COST_INVENTORY");
  assert.equal(classifySessionCommand("status"), "STATUS");
});

test("live spend routing requires retrieval intent and explicit or session AWS scope", () => {
  for (const question of ["Explain AWS billing", "Explain how much AWS costs", "What is AWS pricing?", "How does AWS billing work?"]) {
    assert.equal(classifySessionCommand(question, "AWS"), "RUN", question);
  }
  for (const provider of ["AWS", "AZURE", "GCP"] as const) {
    assert.equal(classifySessionCommand("How much did Azure cost last month?", provider), "COST_UNSUPPORTED");
    assert.equal(classifySessionCommand("Show GCP spend last month", provider), "COST_UNSUPPORTED");
    assert.equal(classifySessionCommand("Show AWS and Azure costs last month", provider), "COST_UNSUPPORTED");
    assert.equal(classifySessionCommand("Show AWS spend last month", provider), "COST_QUERY");
    assert.equal(classifySessionCommand("Show spend last month", provider), provider === "AWS" ? "COST_QUERY" : "COST_UNSUPPORTED");
  }
  assert.equal(classifySessionCommand("Show spend last month"), "COST_UNSUPPORTED");
});

test("unsupported provider reads are refused before credential resolution even in live sessions", async () => {
  const { graph } = createSessionGraph(":memory:");
  for (const [provider, request] of [
    ["AWS", "How much did Azure cost last month?"],
    ["AZURE", "Show spend last month"],
    ["GCP", "List tags on EC2 volumes"],
  ] as const) {
    const result = await graph.invoke({ request, provider, engine: "TERRAFORM", approveBuild: false, fixture: false },
      { configurable: { thread_id: "unsupported-cost-" + provider } });
    assert.equal(result.history.at(-1)?.command, "COST_UNSUPPORTED");
    assert.match(result.response ?? "", /support AWS only/);
    assert.match(result.response ?? "", /No AWS calls were made/);
    assert.doesNotMatch(result.response ?? "", /Set AWS_PROFILE|SSO/);
  }
});

test("cost rows identify each daily billing interval for groups and totals", () => {
  const query = parseCostQuestion("Show spend for the last 7 days", new Date("2026-11-03T12:00:00Z"));
  const response = formatAwsCosts({ ResultsByTime: [
    { TimePeriod: { Start: "2026-10-27", End: "2026-10-28" }, Groups: [
      { Keys: ["Amazon Elastic Compute Cloud - Compute"], Metrics: { UnblendedCost: { Amount: "2.5", Unit: "USD" } } },
    ] },
    { TimePeriod: { Start: "2026-10-28", End: "2026-10-29" }, Total: { UnblendedCost: { Amount: "3", Unit: "USD" } } },
    { Groups: [{ Keys: ["KMS"], Metrics: { UnblendedCost: { Amount: "1", Unit: "USD" } } }] },
  ] }, query, "111111111111");
  assert.match(response, /2026-10-27 through 2026-10-28 \(end date exclusive\) — Amazon Elastic Compute Cloud - Compute: 2\.50 USD/);
  assert.match(response, /2026-10-28 through 2026-10-29 \(end date exclusive\) — Total: 3\.00 USD/);
  assert.match(response, /billing interval unavailable — KMS: 1\.00 USD/);
});

test("inventory redacts API and access-key tag variants while preserving nonsensitive values", () => {
  for (const key of ["api-key", "ApiKey", "access_key", "API_KEY", "AccessKey", "api key", "access-key-id",
    "secret", "token", "password", "credential", "private.key", "private-key"]) {
    assert.equal(tagValue(key, "synthetic-sensitive-value"), "[redacted]", key);
  }
  assert.equal(tagValue("CostCenter", "engineering"), "engineering");
  assert.equal(tagValue("Name", "dev-key"), "dev-key");
});

test("fixture sessions refuse live cost reads without making AWS calls", async () => {
  const { graph } = createSessionGraph(":memory:");
  const result = await graph.invoke({ request: "How much did KMS cost last month?", provider: "AWS", engine: "TERRAFORM",
    mock: "brownfield", approveBuild: false, fixture: true }, { configurable: { thread_id: "fixture-cost-query" } });
  assert.match(result.response ?? "", /unavailable in fixture sessions/i);
  assert.match(result.response ?? "", /no AWS calls were made/i);
});

test("operator credential handoff accepts only short-lived IAM Identity Center profiles", () => {
  assert.equal(operatorReadCredentials({ env: {} }).ok, false);
  const calls: string[][] = [];
  const fakeCli = (args: string[]) => {
    calls.push(args);
    const key = args[2];
    if (args[1] === "export-credentials") return { status: 0, stdout: "{}" };
    if (key === "credential_process") return { status: 0, stdout: "aws credential helpers\n" };
    return { status: 1, stdout: "" };
  };
  const blocked = operatorReadCredentials({ env: { AWS_PROFILE: "operator" }, runAws: fakeCli });
  assert.equal(blocked.ok, false);
  assert.equal(calls.some((args) => args[1] === "export-credentials"), false, "never exports from a credential_process profile");

  const now = Date.parse("2026-11-03T12:00:00Z");
  const responses = new Map<string, { status: number; stdout: string }>([
    ["credential_process", { status: 1, stdout: "" }], ["source_profile", { status: 1, stdout: "" }],
    ["credential_source", { status: 1, stdout: "" }], ["sso_session", { status: 0, stdout: "adaptcloud\n" }],
    ["sso_start_url", { status: 1, stdout: "" }], ["sso_account_id", { status: 0, stdout: "973471129135\n" }],
    ["sso_role_name", { status: 0, stdout: "AWSAdministratorAccess\n" }],
    ["export-credentials", { status: 0, stdout: JSON.stringify({ AccessKeyId: "ASIAFAKEACCESS", SecretAccessKey: "fake-secret-value",
      SessionToken: "fake-session-token-value", Expiration: "2026-11-03T13:00:00Z" }) }],
    ["region", { status: 0, stdout: "us-east-2\n" }],
  ]);
  const accepted = operatorReadCredentials({ env: { AWS_PROFILE: "adaptcloud-admin" }, now: () => now,
    runAws: (args) => responses.get(args[1] === "export-credentials" ? args[1] : args[2]) });
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    assert.deepEqual(Object.keys(accepted.credentials.env).sort(), ["ALZ_DISCOVERY_AWS_ACCESS_KEY_ID", "ALZ_DISCOVERY_AWS_DEFAULT_REGION",
      "ALZ_DISCOVERY_AWS_REGION", "ALZ_DISCOVERY_AWS_SECRET_ACCESS_KEY", "ALZ_DISCOVERY_AWS_SESSION_TOKEN"].sort());
    assert.equal(accepted.credentials.region, "us-east-2");
  }
});
