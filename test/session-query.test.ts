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
    classifySessionCommand("what else can you do?"),
    "HELP",
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
  assert.equal(
    classifySessionCommand(
      "prompt guide",
    ),
    "PROMPT_GUIDE",
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

test("empty conversational state returns a valid natural-language starter", () => {
  const answer = answerStateQuery(
    "STATUS",
  );

  assert.match(
    answer,
    /Inspect this environment and assess its security and resiliency posture/,
  );
});


test("prompt guide teaches allowed, blocked, and self-help patterns", () => {
  const answer = answerStateQuery(
    "PROMPT_GUIDE",
  );

  assert.match(
    answer,
    /Prompts that work/,
  );
  assert.match(
    answer,
    /Prompts that are blocked/,
  );
  assert.match(
    answer,
    /\.\/alz prompts/,
  );
  assert.match(
    answer,
    /without revealing secret values/i,
  );
});
