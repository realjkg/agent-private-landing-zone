import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { chooseOperatorJob } from "../src/operator-ui/server.js";

const doc = readFileSync("docs/cli-ui-journey-map.md", "utf8");
const block = /```journey-map\n([\s\S]*?)```/.exec(doc)?.[1] ?? "";
const rows = block.split("\n").filter(Boolean).map((line) => {
  const [command, ui, covered] = line.split("|").map((part) => part.trim());
  return { command, ui, covered: (covered ?? "").split(",").map((file) => file.trim()).filter(Boolean) };
});
const byCommand = new Map(rows.map((row) => [row.command, row]));

const operatorSource = readFileSync("src/cli/operator.ts", "utf8");
const serverSource = readFileSync("src/operator-ui/server.ts", "utf8");

test("the map has rows, and each names its test files", () => {
  assert.ok(rows.length > 20);
  assert.equal(byCommand.size, rows.length, "duplicate command in the map");
  for (const row of rows) {
    assert.ok(row.command && row.ui && row.covered.length > 0, JSON.stringify(row));
    for (const file of row.covered) assert.ok(existsSync(file), row.command + " names a missing test: " + file);
  }
});

test("every ./alz command is in the map, and the map names no command that does not exist", () => {
  const dispatched = new Set(
    [...operatorSource.matchAll(/command\s*===\s*"([a-z-]+)"/g)]
      .map((match) => match[1])
      .filter((name) => !["help", "--help", "-h"].includes(name)),
  );
  dispatched.add("bootstrap"); // handled by the ./alz shell wrapper before the CLI starts
  const mapped = new Set(rows.filter((row) => row.command.startsWith("alz ")).map((row) => row.command.slice(4)));
  assert.deepEqual([...dispatched].sort(), [...mapped].sort(),
    "a command was added or removed: update docs/cli-ui-journey-map.md");
});

test("every console workflow is in the map, and every claimed one exists", () => {
  const declared = /new Set<OperatorMode>\(\[([^\]]*)\]\)/.exec(serverSource)?.[1] ?? "";
  const modes = [...declared.matchAll(/"([a-z-]+)"/g)].map((match) => match[1]);
  assert.ok(modes.length >= 4);
  const claimed = rows.flatMap((row) => row.ui.startsWith("UI:") ? row.ui.slice(3).split(",") : [])
    .filter((name) => !["host", "models-probe"].includes(name));
  assert.deepEqual([...claimed].sort(), [...modes].sort(),
    "a console workflow was added or removed: update docs/cli-ui-journey-map.md");
  for (const mode of modes) assert.doesNotThrow(() => chooseOperatorJob(mode, "all"), mode);
});

test("teardown is operator-only: no console workflow reaches it", () => {
  assert.equal(byCommand.get("alz teardown")?.ui, "NONE");
  for (const mode of ["matrix-offline", "matrix-live", "aws-review", "chaos"]) {
    const job = chooseOperatorJob(mode, "all");
    assert.doesNotMatch(job.script + " " + job.args.join(" "), /teardown|destroy|apply/i, mode);
  }
  assert.doesNotMatch(serverSource, /teardown/i, "the console server must not mention teardown");
});
