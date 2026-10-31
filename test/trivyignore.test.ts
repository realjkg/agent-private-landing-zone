import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

// The Trivy ignore file (.trivyignore.yaml, read by the supply-chain scan). Each entry must stay narrow: an id, the exact
// files it covers and an honest statement. A broad or stale ignore would hide a real finding, so this test owns the file.

const ROOT = resolve(import.meta.dirname, "..");
type Entry = { id: string; paths: string[]; statement: string };

function entries(): Entry[] {
  const text = readFileSync(join(ROOT, ".trivyignore.yaml"), "utf8");
  assert.match(text, /^misconfigurations:\n/);
  return text.split("\n  - id: ").slice(1).map((block) => {
    const id = block.split("\n")[0].trim();
    const paths = /\n {4}paths: (\[.*\])\n/.exec(block)?.[1];
    const statement = /\n {4}statement: (.+)/.exec(block)?.[1]?.trim() ?? "";
    assert.ok(paths, id + " has no paths");
    return { id, paths: JSON.parse(paths) as string[], statement };
  });
}

/** A path, or a `*` glob in the file name only, matched against the files on disk. */
function matches(pattern: string): string[] {
  const dir = dirname(pattern), name = pattern.slice(dir.length + 1);
  if (!name.includes("*")) return existsSync(join(ROOT, pattern)) ? [pattern] : [];
  const regex = new RegExp("^" + name.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "$");
  return existsSync(join(ROOT, dir)) ? readdirSync(join(ROOT, dir)).filter((file) => regex.test(file)) : [];
}

test("every ignore names a check, files that exist, and a statement; none covers a directory or a broad glob", () => {
  const all = entries();
  assert.ok(all.length > 0);
  for (const entry of all) {
    assert.match(entry.id, /^AWS-\d{4}$/, entry.id);
    assert.ok(entry.statement.length >= 20, entry.id + " needs an honest statement");
    assert.ok(entry.paths.length > 0, entry.id);
    for (const path of entry.paths) {
      assert.doesNotMatch(path, /\*\*|^\/|\/$|^\.|\*.*\//, entry.id + " " + path + " is broader than named files");
      assert.ok(dirname(path).split("/").every((segment) => !segment.includes("*")), entry.id + " " + path);
      assert.ok(matches(path).length > 0, entry.id + " " + path + " matches no file: a stale ignore");
    }
  }
});

test("the cost-baseline ignore covers only AWS-0132, and exactly the goldens that render the export bucket", () => {
  const goldens = resolve(ROOT, "test", "fixtures", "cost-baseline");
  const withBucket = readdirSync(goldens).sort()
    .filter((name) => readFileSync(join(goldens, name, "main.tf"), "utf8").includes('resource "aws_s3_bucket" "cost_export"'))
    .map((name) => "test/fixtures/cost-baseline/" + name + "/main.tf");
  assert.ok(withBucket.length > 0);
  const cost = entries().filter((entry) => entry.paths.some((path) => path.startsWith("test/fixtures/cost-baseline/")));
  assert.deepEqual(cost.map((entry) => entry.id), ["AWS-0132"], "the topic encryption and public access findings are never ignored");
  assert.deepEqual([...cost[0].paths].sort(), withBucket);
  assert.match(cost[0].statement, /SSE-S3 by design/);
  assert.match(cost[0].statement, /ADOPT_EXISTING/);
});
