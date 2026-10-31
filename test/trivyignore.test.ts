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

test("the cost-baseline ignores cover only AWS-0132 and AWS-0095, each on exactly the goldens that render it", () => {
  const goldens = resolve(ROOT, "test", "fixtures", "cost-baseline");
  const rendering = (predicate: (text: string) => boolean) => readdirSync(goldens).sort()
    .filter((name) => predicate(readFileSync(join(goldens, name, "main.tf"), "utf8")))
    .map((name) => "test/fixtures/cost-baseline/" + name + "/main.tf");
  const withBucket = rendering((text) => text.includes('resource "aws_s3_bucket" "cost_export"'));
  const unencryptedTopic = rendering((text) => text.includes('resource "aws_sns_topic" "cost_alerts"') &&
    !text.includes("kms_master_key_id"));
  const encryptedTopic = rendering((text) => text.includes("kms_master_key_id = aws_kms_key.cost_alerts.arn"));
  assert.ok(withBucket.length > 0 && unencryptedTopic.length > 0);
  assert.ok(encryptedTopic.length > 0, "a golden keeps the opt-in customer-managed key variant");
  const cost = entries().filter((entry) => entry.paths.some((path) => path.startsWith("test/fixtures/cost-baseline/")));
  assert.deepEqual(cost.map((entry) => entry.id).sort(), ["AWS-0095", "AWS-0132"],
    "the public access findings are never ignored for the cost goldens");
  const bucket = cost.find((entry) => entry.id === "AWS-0132")!;
  assert.deepEqual([...bucket.paths].sort(), withBucket);
  assert.match(bucket.statement, /SSE-S3 by design/);
  assert.match(bucket.statement, /ADOPT_EXISTING/);
  const topic = cost.find((entry) => entry.id === "AWS-0095")!;
  assert.deepEqual([...topic.paths].sort(), unencryptedTopic, "never the encrypted golden");
  assert.match(topic.statement, /owner's decision of 2026-10-31/);
  assert.match(topic.statement, /CUSTOMER_KMS/);
});
