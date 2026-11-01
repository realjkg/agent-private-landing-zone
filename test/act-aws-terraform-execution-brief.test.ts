import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { runApplyCommand } from "../src/cli/apply.js";
import { parseEvidenceArgs } from "../src/cli/evidence.js";
import { readCostStatus } from "../src/cost/status.js";
import { renderAwsCostBaselineProject } from "../src/build/cost-baseline.js";
import { resolveCostConfig } from "../src/design/cost.js";
import { CLOUD_CONTROL_TYPES } from "../src/observe/verify.js";
import type { HumanTerminal } from "../src/cli/teardown-driver.js";
import { operationGroups } from "../src/operations/registry.js";

// The prefilled AWS Terraform execution brief (#39, 6508815426 item 5). Documentation only: the eight owner fields stay
// verbatim, and every `./alz` command it names exists in the CLI as it is today. The command tables are read from the
// CLI itself (its refusals, its exported parser and its catalog), never from a list kept here.

const BRIEF = readFileSync("docs/act-aws-terraform-execution-brief.md", "utf8");

const OWNER_FIELDS = [
  "DEV AWS account:",
  "Region:",
  "State bucket/key and workspace:",
  "Verified role ARNs and identity-delivery configuration:",
  "Canary name and owner tag:",
  "Approved spend ceiling, period and expiry:",
  "Cleanup owner and maximum lifetime:",
  "Requester/approver public identities:",
];

test("the brief lists exactly the eight owner fields, verbatim, in one block", () => {
  const blocks = [...BRIEF.matchAll(/```text\n([\s\S]*?)```/g)].map((match) => match[1].trim().split("\n"));
  assert.ok(blocks.some((lines) => JSON.stringify(lines) === JSON.stringify(OWNER_FIELDS)), "the owner field block changed");
  // Each field is mapped in the table that follows the block.
  for (const field of OWNER_FIELDS) assert.ok(BRIEF.includes("| " + field.slice(0, -1) + " |"), "no mapping row for " + field);
  // The two bounds the owner enforces are said to be outside the product's checks.
  for (const field of ["Approved spend ceiling, period and expiry", "Cleanup owner and maximum lifetime"]) {
    const row = BRIEF.split("\n").find((line) => line.startsWith("| " + field + " |")) ?? "";
    assert.match(row, /Owner-enforced; the product does not check this\./, field);
  }
});

test("the brief authorizes nothing and keeps ACT disabled", () => {
  assert.match(BRIEF, /This page authorizes nothing\./);
  assert.match(BRIEF, /ACT stays DISABLED/);
  assert.match(BRIEF, /never initiate an apply/);
});

test("the prefilled decisions match the shipped AWS DEV example contract and the committed canary", () => {
  const example = JSON.parse(readFileSync("config/act-pilot-contract.aws-dev.example.json", "utf8")) as Record<string, unknown>;
  assert.equal(example.provider, "AWS");
  assert.equal(example.engine, "TERRAFORM");
  assert.equal(example.embedStateWrite, true);
  assert.deepEqual(example.enabledEnvironments, ["DEV"]);
  assert.deepEqual(example.requiredApprovals, { DEV: 1 });
  assert.equal(example.maxApprovalAgeMinutes, 30);
  assert.equal(example.killSwitchPath, ".runs/apply/KILL");
  const dev = (example.targets as Record<string, Record<string, unknown>>).DEV;
  assert.deepEqual(dev.canary, { resources: [{ type: "aws_cloudwatch_log_group", count: 1 }] });
  for (const text of ['"embedStateWrite": true', '"enabledEnvironments": ["DEV"]', '"requiredApprovals": { "DEV": 1 }',
    '"killSwitchPath": ".runs/apply/KILL"', '"authorize": { "DEV": ["APPLY", "CLEANUP"] }',
    '"canary": { "resources": [{ "type": "aws_cloudwatch_log_group", "count": 1 }] }']) {
    assert.ok(BRIEF.includes(text), "the brief does not state " + text);
  }
  const canary = readFileSync("qualification/aws/act-dev1-canary/main.tf", "utf8");
  assert.equal([...canary.matchAll(/^resource "([a-z0-9_]+)"/gm)].map((match) => match[1]).join(","), "aws_cloudwatch_log_group");
  assert.match(canary, /var\.region == "us-east-2"/, "the brief says the canary accepts only us-east-2");
  for (const name of ["canary_name", "owner"]) assert.match(canary, new RegExp('variable "' + name + '"'), name);
});

// --- the command tables, read from the CLI -------------------------------------------------------------------------

const terminal: HumanTerminal = { stdinIsTTY: true, stdoutIsTTY: true, write: () => undefined, ask: () => Promise.resolve("") };

/** What `./alz apply` says when it refuses: the refusal names the real table. Nothing is read, run or written. */
async function applyRefusal(args: string[]): Promise<string> {
  let text = "";
  const code = await runApplyCommand(args, { terminal, stdout: () => undefined, stderr: (chunk) => { text += chunk; } });
  assert.equal(code, 1, args.join(" "));
  return text;
}

async function applySubcommands(): Promise<Set<string>> {
  const text = await applyRefusal(["zz-not-a-subcommand"]);
  const list = /APPLY_SUBCOMMAND_UNKNOWN: use one of ([^\n]+)/.exec(text)?.[1];
  assert.ok(list, text);
  return new Set(list.split(", "));
}

type UsageLine = { required: Set<string>; all: Set<string>; values: Map<string, string> };

/**
 * The usage `./alz apply` prints with the same refusal: per subcommand, the flags outside brackets (required), every flag, and
 * each flag's documented value (a placeholder such as `APPLY_REQUEST.json`, or literal alternatives such as `delivered|cleaned`).
 */
async function applyUsage(): Promise<Map<string, UsageLine>> {
  const text = await applyRefusal(["zz-not-a-subcommand"]);
  const usage = new Map<string, UsageLine>();
  for (const match of text.matchAll(/^ {2}\.\/alz apply ([a-z-]+) (.*)$/gm)) {
    if (usage.has(match[1])) continue;
    const line: UsageLine = { required: new Set(), all: new Set(), values: new Map() };
    const words = match[2].split(/\s+/);
    let depth = 0;
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index];
      const opened = word.startsWith("[");
      const flag = word.replace(/^\[/, "");
      if (flag.startsWith("--")) {
        const name = flag.slice(2);
        line.all.add(name);
        if (depth === 0 && !opened) line.required.add(name);
        if (!line.values.has(name)) line.values.set(name, (words[index + 1] ?? "").replace(/\]+$/, ""));
      }
      depth += (word.match(/\[/g) ?? []).length - (word.match(/\]/g) ?? []).length;
    }
    usage.set(match[1], line);
  }
  return usage;
}

async function applyFlags(sub: string): Promise<Set<string>> {
  const text = await applyRefusal([sub, "--zz-not-a-flag", "x"]);
  const list = /takes only --(.*?); there is no flag/.exec(text)?.[1];
  assert.ok(list !== undefined, text);
  return new Set(list.split(", --"));
}

/** Top-level commands: the CLI's own branches, the launcher's `bootstrap` and the catalog groups. */
function topLevelCommands(): Set<string> {
  const operator = readFileSync("src/cli/operator.ts", "utf8");
  const launcher = readFileSync("alz", "utf8");
  const names = new Set([...operator.matchAll(/command\s*===\s*"([a-z-]+)"/g)].map((match) => match[1]));
  for (const match of launcher.matchAll(/"\$\{1:-\}"\s*==\s*"([a-z-]+)"/g)) names.add(match[1]);
  for (const group of operationGroups().keys()) names.add(group);
  return names;
}

/** Every `./alz ...` the brief names: inline code spans and command lines in code blocks (a trailing `# comment` dropped). */
function briefCommands(): string[][] {
  const found: string[] = [];
  for (const match of BRIEF.matchAll(/`(\.\/alz\b[^`]*)`/g)) found.push(match[1]);
  for (const block of BRIEF.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
    for (const line of block[1].split("\n")) if (line.trim().startsWith("./alz")) found.push(line.trim().replace(/\s+#.*$/, ""));
  }
  return found.map((command) => command.replace(/[[\]]/g, "").split(/\s+/).filter(Boolean).slice(1));
}

test("every ./alz command and flag the brief names exists in the CLI", async () => {
  const commands = briefCommands();
  assert.ok(commands.length > 20, "the brief names its commands");
  const top = topLevelCommands();
  const applySubs = await applySubcommands();
  const usage = await applyUsage();
  const flagCache = new Map<string, Set<string>>();
  for (const words of commands) {
    const shown = "./alz " + words.join(" ");
    const [command, sub, ...rest] = words;
    if (command === undefined || command === "") continue; // the launcher itself, `./alz`
    assert.ok(top.has(command), shown + ": no such command");
    if (sub === undefined) continue;
    if (command === "apply") {
      assert.ok(applySubs.has(sub), shown + ": no such apply subcommand");
      if (!flagCache.has(sub)) flagCache.set(sub, await applyFlags(sub));
      for (const word of rest) if (word.startsWith("--")) assert.ok(flagCache.get(sub)!.has(word.slice(2)), shown + ": no flag " + word);
      const line = usage.get(sub);
      assert.ok(line, sub + " has a usage line");
      // Every required flag is given (review N13).
      // A bare name in prose (`./alz apply preflight`) refers to the command; a full invocation (one with any flag) must be runnable.
      if (rest.some((word) => word.startsWith("--"))) {
        for (const name of line.required) assert.ok(rest.includes("--" + name), shown + ": missing the required --" + name);
      }
      for (let index = 0; index < rest.length; index += 1) {
        if (!rest[index].startsWith("--")) continue;
        const name = rest[index].slice(2);
        const value = rest[index + 1] ?? "";
        const documented = line.values.get(name) ?? "";
        // A fixed choice (`delivered|cleaned`, `DEV|QA|PROD`, the delivery paths) must be one of its values.
        if (documented.includes("|") && !value.startsWith("<")) assert.ok(documented.split("|").includes(value), shown + ": --" + name + " " + value + " is not one of " + documented);
        // The request file is the one this command takes: apply and cleanup take APPLY_REQUEST.json, qualify and seal REQUEST.json (#365 B1).
        if (name === "request") assert.equal(value, "<" + documented + ">", shown + ": --request must be " + documented);
      }
    } else if (command === "evidence") {
      const parsed = parseEvidenceArgs([sub, ...rest]);
      assert.ok(!("error" in parsed), shown + ": " + ("error" in parsed ? parsed.error : ""));
    } else {
      const specs = operationGroups().get(command);
      assert.ok(specs, shown + ": takes no subcommand");
      const spec = specs.find((candidate) => candidate.command!.sub === sub);
      assert.ok(spec, shown + ": no such subcommand");
      const documented = spec.cli.replace(/[[\]]/g, "").split(/\s+/);
      for (const word of rest) if (word.startsWith("--")) assert.ok(documented.includes(word), shown + ": no flag " + word);
      // Each flag the catalog line shows outside brackets is required for a full invocation.
      const required = spec.cli.replace(/\[[^\]]*\]/g, "").split(/\s+/).filter((word) => word.startsWith("--"));
      if (rest.length > 0) for (const flag of required) assert.ok(rest.includes(flag), shown + ": missing the required " + flag);
    }
  }
});

test("the command check refuses a command, a subcommand and a flag the CLI does not have", async () => {
  // The oracle itself: each table is non-empty and rejects an invented entry, so the test above cannot pass vacuously.
  assert.ok(!topLevelCommands().has("pin"), "./alz pin was removed with the hash pin");
  const subs = await applySubcommands();
  assert.ok(subs.has("seal") && subs.has("identity-check") && !subs.has("pin"));
  const seal = await applyFlags("seal");
  assert.deepEqual([...seal].sort(), ["key", "manifest", "request", "requester"]);
  assert.ok("error" in parseEvidenceArgs(["run", "--stage", "act:aws-terraform-typo"]));
  assert.ok(!("error" in parseEvidenceArgs(["run", "--stage", "cleanup:aws-terraform"])));
});

test("the usage the CLI prints agrees with the flags it enforces, so the required-flag check reads the real table", async () => {
  const usage = await applyUsage();
  const subs = await applySubcommands();
  assert.deepEqual([...usage.keys()].sort(), [...subs].sort());
  for (const sub of subs) {
    const line = usage.get(sub)!;
    assert.deepEqual([...line.all].sort(), [...await applyFlags(sub)].sort(), sub);
    // With no flags at all, the parser names a missing flag that the usage also marks required. Only subcommands with a
    // required flag are probed this way, so nothing runs.
    if (line.required.size === 0) continue;
    const text = await applyRefusal([sub]);
    const missing = /APPLY_ARGUMENT_REQUIRED: --([a-z-]+)/.exec(text)?.[1];
    assert.ok(missing && line.required.has(missing), sub + ": " + text);
  }
  assert.equal(usage.get("apply")!.values.get("request"), "APPLY_REQUEST.json");
  assert.equal(usage.get("seal")!.values.get("request"), "REQUEST.json");
  assert.deepEqual([...usage.get("status")!.required], []);
});

test("the cost-baseline payload section links the deploy page and matches the shipped limits example", () => {
  assert.ok(BRIEF.includes("## Cost baseline as payload"));
  assert.ok(BRIEF.includes("](cost-baseline-deploy.md)"));
  assert.ok(existsSync("docs/cost-baseline-deploy.md") && existsSync("config/cost.example.json"));
  const limitsExample = JSON.parse(readFileSync("config/act-pilot-contract.aws-dev-limits.example.json", "utf8")) as {
    targets: { DEV: { limits: { regions: string[]; resources: { type: string }[] }; canary?: unknown } };
  };
  const limits = limitsExample.targets.DEV.limits;
  assert.equal(limitsExample.targets.DEV.canary, undefined);
  assert.deepEqual(limits.regions, ["us-east-2", "us-east-1"]);
  // The brief tells the owner to add these two only when the matching option is on: the example leaves them out.
  const types = limits.resources.map((entry) => entry.type);
  for (const optIn of ["aws_kms_key", "aws_budgets_budget_action"]) {
    assert.ok(!types.includes(optIn), optIn);
    assert.ok(BRIEF.includes("Add `" + optIn + "` only if"), optIn);
  }
});

test("the brief lists the owner's minimum acceptance items 1 to 8 for the cost baseline, each with its evidence source", () => {
  const items = [
    "A deployed budget with the intended amount, filters, and recipients",
    "Confirmed notification subscriptions and a safe test of the notification route",
    "Required tags present on supported deployed resources",
    "Cost-allocation tag activation status reported",
    "A valid export configuration and observed first delivery, or an explicit waiting state",
    "Configured provisioning limits tested against allowed and refused examples",
    "If analytics is selected, successful ingestion and dashboard refresh with timestamps",
    "Clear separation between observed billing, estimates, and unknown values",
  ];
  items.forEach((item, index) => assert.ok(BRIEF.includes("| " + (index + 1) + " | " + item + " |"), "acceptance item " + (index + 1)));
  // The evidence names fields the saved status really has.
  const status = readFileSync("src/cost/status.ts", "utf8");
  for (const field of ["hasActualAlert", "spendCalculatedAt", "hardSpendCap", "configValid", "analyticsIngestion", "UNIT_TAGGED_RESOURCES_ONLY", "NOT_REPORTED_BY_AWS", "NOT_SELECTED"]) {
    assert.ok(status.includes(field) && BRIEF.includes(field), field);
  }
});

test("the cost payload's expected observe, cleanup and day-one results match the code (#378 review B1-B3)", async () => {
  const section = BRIEF.slice(BRIEF.indexOf("## Cost baseline as payload"), BRIEF.indexOf("## Stop and recovery"));
  // B1: the rendered types with no Cloud Control mapping are UNVERIFIABLE at observe.
  const config = resolveCostConfig({ ...JSON.parse(readFileSync("config/cost.example.json", "utf8")), activateCostAllocationTags: true });
  const rendered = renderAwsCostBaselineProject(config);
  const createdTypes = new Set(rendered.metadata.creates.map((entry) => entry.type));
  const unmapped = [...createdTypes].filter((type) => !Object.hasOwn(CLOUD_CONTROL_TYPES, type)).sort();
  // Every unmapped rendered type is named as UNVERIFIABLE, and every mapped one as checkable.
  assert.ok(unmapped.includes("aws_budgets_budget") && unmapped.includes("aws_sns_topic_subscription") && unmapped.includes("aws_ce_cost_allocation_tag"));
  const observeText = section.slice(section.indexOf("**Observe (`./alz apply observe`):**"), section.indexOf("**Cost status on day one:**"));
  const [mappedPart, unmappedPart] = observeText.split("Every other rendered type records");
  for (const type of unmapped) assert.ok(unmappedPart.includes("`" + type + "`") && !mappedPart.includes("`" + type + "`"), type);
  for (const type of [...createdTypes].filter((type) => Object.hasOwn(CLOUD_CONTROL_TYPES, type))) assert.ok(mappedPart.includes("`" + type + "`"), type);
  assert.ok(section.includes("UNVERIFIABLE") && section.includes("NO_CLOUD_CONTROL_MAPPING"));
  // B1: the export bucket keeps billing data (force_destroy false), so cleanup after a delivery is expected to fail closed.
  const bucketBlock = rendered.terraform.slice(rendered.terraform.indexOf('resource "aws_s3_bucket" "cost_export" {'));
  assert.match(bucketBlock.slice(0, bucketBlock.indexOf("\n}\n")), /^\s*force_destroy\s*=\s*false$/m);
  assert.ok(section.includes("`force_destroy = false`") && section.includes("expected to fail closed"));
  assert.ok(section.includes("NOT_INDEPENDENTLY_CHECKABLE") && readFileSync("src/apply/leftovers.ts", "utf8").includes('"NOT_INDEPENDENTLY_CHECKABLE"'));
  // B2: the day-one expectation names INCOMPLETE and ATTENTION, and never "Expect WAITING on the first day".
  assert.ok(!section.includes("Expect `WAITING` on the first day"));
  assert.ok(section.includes("`overall` is expected to read `INCOMPLETE`") && section.includes("`ATTENTION`"));
  // B3: under the default route the budget's subscriber is the topic.
  assert.equal(JSON.parse(readFileSync("config/cost.example.json", "utf8")).notifications.route, "SNS_TOPIC");
  assert.ok(section.includes("Under the default `SNS_TOPIC` route") && section.includes("`EMAIL_DIRECT`"));
  // N4: --unit and --region together, refused before any read.
  let reads = 0;
  await assert.rejects(readCostStatus({ accountId: "111111111111", budgetName: "alz-cost-baseline", requiredTagKeys: [], unitId: "alzu-0" } as never,
    async () => { reads += 1; return {}; }), /COST_STATUS_UNIT_NEEDS_REGION/);
  assert.equal(reads, 0);
  assert.ok(section.includes("COST_STATUS_UNIT_NEEDS_REGION") && section.includes("COST_STATUS_EXPORT_ACCOUNT_MISMATCH"));
  assert.ok(readFileSync("src/cli/cost.ts", "utf8").includes("COST_STATUS_EXPORT_ACCOUNT_MISMATCH"));
  // N5: the build's own refusals.
  const build = readFileSync("src/cli/real-private-build.ts", "utf8");
  for (const code of ["SOURCE_WORKTREE_DIRTY", "AGENT_SKIP_LOCAL_MODEL"]) assert.ok(build.includes(code) && section.includes(code), code);
});
