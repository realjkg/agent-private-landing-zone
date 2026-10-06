import assert from "node:assert/strict";
import test from "node:test";

import {
  answerStateQuery,
  classifySessionCommand,
} from "../src/session/query.js";

test("session recognizes conversational state queries", () => {
  assert.equal(
    classifySessionCommand("status"),
    "STATUS",
  );
  assert.equal(
    classifySessionCommand(
      "what did you find?",
    ),
    "ENVIRONMENT",
  );
  assert.equal(
    classifySessionCommand(
      "show me the evidence",
    ),
    "EVIDENCE",
  );
  assert.equal(
    classifySessionCommand(
      "why is this blocked?",
    ),
    "EXPLAIN",
  );
  assert.equal(
    classifySessionCommand(
      "what should we do next?",
    ),
    "NEXT",
  );
  assert.equal(
    classifySessionCommand(
      "compare Terraform with Pulumi",
    ),
    "COMPARE_IAC",
  );
});

test("session recognizes conversational engine switching", () => {
  assert.equal(
    classifySessionCommand(
      "use Pulumi instead",
    ),
    "USE_PULUMI",
  );
  assert.equal(
    classifySessionCommand(
      "switch to Terraform",
    ),
    "USE_TERRAFORM",
  );
});

test("session help teaches natural language instead of requiring commands", () => {
  const answer = answerStateQuery(
    "HELP",
  );

  assert.match(
    answer,
    /Talk to me normally/,
  );
  assert.match(
    answer,
    /Inspect this AWS environment/,
  );
  assert.match(
    answer,
    /Use Pulumi instead/,
  );
});
