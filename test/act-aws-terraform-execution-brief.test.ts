import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { runApplyCommand } from "../src/cli/apply.js";
import { parseEvidenceArgs } from "../src/cli/evidence.js";
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
      for (const word of rest) if (word.startsWith("--")) assert.ok(spec.cli.split(/\s+/).includes(word), shown + ": no flag " + word);
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
