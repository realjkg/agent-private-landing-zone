import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  completeTask,
  demoArguments,
  nextTask,
  startProgress,
  STUDENT_TASKS,
} from "../src/learn/path.js";

const ROOT = resolve(import.meta.dirname, "..");

test("the student path has exactly three tasks, in order, with distinct ids", () => {
  assert.deepEqual(STUDENT_TASKS.map((task) => task.id), ["look", "find-risk", "explain"]);
  assert.equal(new Set(STUDENT_TASKS.map((task) => task.id)).size, 3);
});

test("every student task uses a demo option the repository already runs offline", () => {
  const providers = new Set(["aws", "azure"]);
  const engines = new Set(["terraform", "pulumi"]);
  const scenarios = new Set(["greenfield", "brownfield", "unknown"]);
  for (const task of STUDENT_TASKS) {
    assert.ok(providers.has(task.fixture.provider), task.id);
    assert.ok(engines.has(task.fixture.engine), task.id);
    assert.ok(scenarios.has(task.fixture.scenario), task.id);
    assert.deepEqual(demoArguments(task), [task.fixture.provider, task.fixture.engine, task.fixture.scenario]);
  }
});

test("progress moves forward through the tasks, ignores unknown or repeated ids, and ends after three", () => {
  let progress = startProgress();
  assert.equal(nextTask(progress)?.id, "look");
  progress = completeTask(progress, "look");
  progress = completeTask(progress, "look");
  progress = completeTask(progress, "not-a-task");
  assert.deepEqual(progress.done, ["look"]);
  assert.equal(nextTask(progress)?.id, "find-risk");
  progress = completeTask(progress, "find-risk");
  progress = completeTask(progress, "explain");
  assert.equal(nextTask(progress), undefined);
});

test("the student path imports no tool, provider, apply, IaC, discovery or agent module", () => {
  const source = readFileSync(join(ROOT, "src/learn/path.ts"), "utf8");
  const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(imports, []);
  assert.doesNotMatch(source, /\bACT\b\s*=\s*true|ALZ_ACT|apply|destroy|credential/i);
});

test("no source under src/learn outside path.ts is added without this test seeing it", () => {
  const files = readdirSync(join(ROOT, "src/learn")).filter((name) => statSync(join(ROOT, "src/learn", name)).isFile());
  assert.deepEqual(files, ["path.ts"]);
});
