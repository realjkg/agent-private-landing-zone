import assert from "node:assert/strict";
import test from "node:test";

import { classifyIntent } from "../src/agent/intent.js";

test("assessment language takes precedence over generic environment context", () => {
  assert.equal(
    classifyIntent(
      "Review this environment and assess operational risk.",
    ),
    "ASSESS",
  );
});

test("explicit discovery requests remain DISCOVER", () => {
  assert.equal(
    classifyIntent(
      "Discover and inventory the resources in this account.",
    ),
    "DISCOVER",
  );
});

test("inspect requests enter discovery", () => {
  assert.equal(
    classifyIntent(
      "Inspect this AWS environment.",
    ),
    "DISCOVER",
  );
});

test("build requests remain BUILD", () => {
  assert.equal(
    classifyIntent(
      "Build additive infrastructure using Terraform.",
    ),
    "BUILD",
  );
});

test("mutation verbs remain CHANGE", () => {
  assert.equal(
    classifyIntent(
      "Deploy an additive platform resource.",
    ),
    "CHANGE",
  );
});
