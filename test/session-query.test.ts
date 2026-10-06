import assert from "node:assert/strict";
import test from "node:test";

import {
  answerStateQuery,
  classifySessionCommand,
} from "../src/session/query.js";

test("session recognizes deterministic state queries", () => {
  assert.equal(
    classifySessionCommand(":status"),
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
      "show evidence",
    ),
    "EVIDENCE",
  );
});

test("session help does not require agent state", () => {
  const answer = answerStateQuery(
    "HELP",
  );

  assert.match(
    answer,
    /:status/,
  );
  assert.match(
    answer,
    /Natural-language requests/,
  );
});
