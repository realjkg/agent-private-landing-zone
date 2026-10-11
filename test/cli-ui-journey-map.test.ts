import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { chooseOperatorJob } from "../src/operator-ui/server.js";
import { OPERATIONS, operationGroups } from "../src/operations/registry.js";
import { assertSafeArgv, sampleArgvs } from "../src/operations/schema.js";
import { WORKFLOW_IDS } from "../src/operations/workflows.js";

const doc = readFileSync("docs/cli-ui-journey-map.md", "utf8");
const block = /```journey-map\n([\s\S]*?)```/.exec(doc)?.[1] ?? "";
const rows = block.split("\n").filter(Boolean).map((line) => {
  const [command, covered] = line.split("|").map((part) => part.trim());
  return { command, covered: (covered ?? "").split(",").map((file) => file.trim()).filter(Boolean) };
});
const byCommand = new Map(rows.map((row) => [row.command, row]));

const operatorSource = readFileSync("src/cli/operator.ts", "utf8");
const serverSource = readFileSync("src/operator-ui/server.ts", "utf8");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(join(directory, entry.name))
      : /\.tsx?$/.test(entry.name) ? [join(directory, entry.name)] : []);
}

test("the map has rows, and each names its test files", () => {
  assert.ok(rows.length > 20);
  assert.equal(byCommand.size, rows.length, "duplicate command in the map");
  for (const row of rows) {
    assert.ok(row.command && row.covered.length > 0, JSON.stringify(row));
    for (const file of row.covered) assert.ok(existsSync(file), row.command + " names a missing test: " + file);
  }
});

test("every ./alz command and catalog command group is in the map, and the map names no command that does not exist", () => {
  const expected = new Set(
    [...operatorSource.matchAll(/command\s*===\s*"([a-z-]+)"/g)]
      .map((match) => match[1])
      .filter((name) => !["help", "--help", "-h"].includes(name)),
  );
  expected.add("bootstrap"); // handled by the ./alz shell wrapper before the CLI starts
  expected.add("enterprise"); // the one reserved group for the enterprise libraries
  for (const group of operationGroups().keys()) expected.add(group);
  const mapped = new Set(rows.filter((row) => row.command.startsWith("alz ")).map((row) => row.command.slice(4)));
  assert.deepEqual([...expected].sort(), [...mapped].sort(),
    "a command or group was added or removed: update docs/cli-ui-journey-map.md");
});

test("every console workflow is a runnable catalog entry that the legacy contract still derives from it", () => {
  assert.deepEqual([...WORKFLOW_IDS].sort(), ["aws-review", "chaos", "matrix-live", "matrix-offline"]);
  for (const id of WORKFLOW_IDS) {
    const spec = OPERATIONS.find((item) => item.id === id);
    assert.ok(spec?.job, id + " must be a runnable catalog entry");
    assert.doesNotThrow(() => chooseOperatorJob(id, "all"), id);
  }
});

test("the console never reaches the destroy-preview driver or an apply/destroy argument", () => {
  // Precise rules (stronger than banning the word "teardown" from the server).
  for (const mode of WORKFLOW_IDS) {
    const job = chooseOperatorJob(mode, "all");
    assert.doesNotMatch(job.script + " " + job.args.join(" "), /teardown|destroy|apply/i, mode);
  }
  assert.doesNotMatch(serverSource, /-destroy|--preview-only/, "the server must never build a destroy argv");
  assert.doesNotMatch(serverSource, /teardown/i, "the console server must not mention teardown");
  // No console-side module imports or spawns the driver.
  const consoleSources = [...sourceFiles("src/operator-ui"), ...sourceFiles("src/operations")];
  for (const file of consoleSources) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /(from|import\(|require\()\s*["'][^"']*(teardown\/driver|teardown-driver)/, file);
    assert.doesNotMatch(text, /spawn[A-Za-z]*\([^)]*teardown/, file);
  }
  // Anything that fronts the driver is a handoff; no runnable entry can build a forbidden argv.
  for (const spec of OPERATIONS) {
    const fronts = [spec.cli, spec.cliScript ?? "", spec.handoff?.command ?? ""]
      .some((text) => /teardown-driver|destroy-preview-run|preview-run/.test(text));
    if (fronts) assert.equal(spec.safety, "HANDOFF", spec.id + " fronts the driver and must be a handoff");
    if (spec.job) {
      assert.doesNotMatch(spec.job.script, /teardown-driver/, spec.id);
      for (const args of sampleArgvs(spec)) assert.doesNotThrow(() => assertSafeArgv(args), spec.id);
    }
  }
});
