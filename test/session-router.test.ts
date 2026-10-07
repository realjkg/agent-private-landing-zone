import assert from "node:assert/strict";
import test from "node:test";

import { routeSessionRequest } from "../src/session/router.js";

test("fixture session routes conversational follow-ups without invoking a model", async () => {
  assert.equal(
    await routeSessionRequest(
      "what should we do next?",
      [],
      true,
    ),
    "NEXT",
  );

  assert.equal(
    await routeSessionRequest(
      "use Pulumi instead",
      [],
      true,
    ),
    "USE_PULUMI",
  );

  assert.equal(
    await routeSessionRequest(
      "Build a safe private runtime.",
      [],
      true,
    ),
    "RUN",
  );

  assert.equal(
    await routeSessionRequest(
      "prepare a simulated recovery point",
      [],
      true,
    ),
    "RECOVERY_PREPARE",
  );

  assert.equal(
    await routeSessionRequest(
      "run a simulated restore drill",
      [],
      true,
    ),
    "RECOVERY_DRILL",
  );
});


test("first-turn inspect request enters the governed agent kernel", async () => {
  assert.equal(
    await routeSessionRequest(
      "Inspect this AWS environment.",
      [],
      false,
    ),
    "RUN",
  );
});
