import assert from "node:assert/strict";
import test from "node:test";

import { blueprintFromGcpApiTopic, GCP_API_TOPIC_ID, GCP_API_TOPIC_TYPE } from "../src/observe/blueprint.js";
import { TOPIC_ID } from "../src/apply/gcp-api-target.js";
import { TOPIC_ID as ENGINE_TOPIC_ID } from "../src/apply/engines/gcp-api.js";

// SYNTHETIC. The GCP API-native blueprint mapper (docs/act-pilot-gcp-api-driver.md D6): one run, one topic, one entry.

const PROJECT = "alz-pilot-dev";
const TOPIC = "alz-act-dev1-0123456789ab";
const NAME = "projects/" + PROJECT + "/topics/" + TOPIC;
const ADDRESS = "google_pubsub_topic." + TOPIC;
const planned = [{ address: ADDRESS, type: GCP_API_TOPIC_TYPE, action: "CREATE" }];
const doc = (over: Record<string, unknown> = {}) => JSON.stringify({ name: NAME, labels: { "alz-unit": "alzu-0123456789abcdef0123" }, ...over });

test("D6: the run's topic read-back maps to exactly one entry: its address, type and resource name, IN_PLAN when the sealed change list names it", () => {
  const blueprint = blueprintFromGcpApiTopic(doc(), planned, { project: PROJECT });
  assert.deepEqual(blueprint, { entries: [{ address: ADDRESS, type: GCP_API_TOPIC_TYPE, arn: null, id: NAME, origin: "IN_PLAN" }], missing: [] });
  const unplanned = blueprintFromGcpApiTopic(doc(), [], { project: PROJECT });
  assert.equal(unplanned.entries[0]!.origin, "NOT_IN_PLAN");
  assert.ok(!JSON.stringify(blueprint).includes("alzu-0123456789abcdef0123"), "labels are never copied: a label is not ownership");
});

test("D6: a name in another project, a malformed name or an id outside the alz- topic rule gives no entry, and the planned topic is missing", () => {
  for (const name of [
    "projects/alz-pilot-prod/topics/" + TOPIC, "projects/" + PROJECT + "/subscriptions/" + TOPIC, "projects/" + PROJECT + "/topics/" + TOPIC + "/x",
    "projects/" + PROJECT + "/topics/other-topic", "projects/" + PROJECT + "/topics/ALZ-UPPER", "//" + NAME, NAME + "/", "projects/A/topics/" + TOPIC,
  ]) {
    assert.deepEqual(blueprintFromGcpApiTopic(doc({ name }), planned, { project: PROJECT }), { entries: [], missing: [ADDRESS] }, name);
  }
});

test("D6: a read-back that is not a topic document is refused, and the refusal never quotes it", () => {
  for (const bad of ["not json", "[]", "null", JSON.stringify({ labels: {} }), JSON.stringify({ name: "" }), doc({ labels: ["a"] })]) {
    assert.throws(() => blueprintFromGcpApiTopic(bad, planned, { project: PROJECT }), (error: Error) => /^STATE_JSON_INVALID/.test(error.message) && !error.message.includes("not json"), bad);
  }
});

test("D6: the mapper's topic id rule is the target module's, character for character (the observe side cannot import the apply path)", () => {
  assert.equal(GCP_API_TOPIC_ID.source, TOPIC_ID.source);
  assert.equal(GCP_API_TOPIC_ID.flags, TOPIC_ID.flags);
  // The engine has no copy of its own (#356 review N1): it imports the target module's.
  assert.equal(ENGINE_TOPIC_ID, TOPIC_ID);
});
