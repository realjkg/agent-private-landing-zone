import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import {
  BEGINNER_EVIDENCE_LINES,
  DEFAULT_EXPERIENCE_LEVEL,
  EXPERIENCE_LEVELS,
  EXPERIENCE_LEVEL_STORAGE_KEY,
  beginnerEvidenceLine,
  parseExperienceLevel,
} from "../src/operator-ui/experience-level.js";
import {
  chooseOperatorJob,
  createLocalOperatorServer,
} from "../src/operator-ui/server.js";

test("experience level contract: three values, beginner default, safe fallback", () => {
  assert.deepEqual([...EXPERIENCE_LEVELS], ["BEGINNER", "ADVANCED", "EXPERT"]);
  assert.equal(DEFAULT_EXPERIENCE_LEVEL, "BEGINNER");
  assert.equal(EXPERIENCE_LEVEL_STORAGE_KEY, "alz.experienceLevel");
  for (const level of EXPERIENCE_LEVELS) {
    assert.equal(parseExperienceLevel(level), level);
  }
  // Unknown or hostile stored values fall back to Beginner without error and
  // can never escalate disclosure.
  for (const hostile of [
    null, undefined, "", "beginner", "expert", "ADVANCED ", "ADMIN", 42, {}, [],
  ]) {
    assert.equal(parseExperienceLevel(hostile), "BEGINNER");
  }
});

test("beginner evidence lines translate known classifications and keep unknown ones honest", () => {
  const basis = chooseOperatorJob("matrix-offline", "all").evidenceBasis;
  assert.ok(BEGINNER_EVIDENCE_LINES[basis], "offline fixture basis must be translated");
  const line = beginnerEvidenceLine(basis);
  assert.notEqual(line, basis);
  assert.match(line, /Protected/);
  // Unknown classifications fall back to the raw string — never dropped.
  assert.equal(beginnerEvidenceLine("MYSTERY BASIS"), "MYSTERY BASIS");
  assert.notEqual(beginnerEvidenceLine("NOT_RUN"), "NOT_RUN");
});

test("experience level never reaches the server: run validation is identical at any level", async () => {
  const { server } = createLocalOperatorServer({
    root: process.cwd(),
    runner: async () => "SYNTHETIC PASS / ACT DISABLED",
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("ADDRESS_UNAVAILABLE");
    const url = "http://127.0.0.1:" + address.port;
    const html = await (await fetch(url)).text();
    const token = html.match(/name="token" value="([0-9a-f]{48})"/)?.[1] ?? "";
    assert.ok(token, "CSRF token must be present");

    // A client-supplied level hint must be ignored: an invalid workflow is
    // rejected with a byte-identical error regardless of the level.
    const rejectWith = async (level: string) => {
      const response = await fetch(url + "/run", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          mode: "shell", scenario: "all", token, experienceLevel: level,
        }),
      });
      return { status: response.status, body: await response.text() };
    };
    const beginnerReject = await rejectWith("BEGINNER");
    const expertReject = await rejectWith("EXPERT");
    assert.equal(beginnerReject.status, 400);
    assert.equal(beginnerReject.status, expertReject.status);
    assert.equal(beginnerReject.body, expertReject.body);
    assert.match(beginnerReject.body, /UNSUPPORTED_WORKFLOW/);

    // A valid run is accepted identically at any level and produces the same
    // state — one run at a time, so settle between starts.
    const startAndSettle = async (level: string) => {
      const response = await fetch(url + "/run", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          mode: "matrix-offline", scenario: "all", token, experienceLevel: level,
        }),
      });
      assert.equal(response.status, 202);
      for (let attempt = 0; attempt < 50; attempt++) {
        const state = await (await fetch(url + "/state")).json() as {
          status: string; evidenceBasis: string; output: string;
        };
        if (state.status !== "RUNNING") return state;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("JOB_NEVER_SETTLED");
    };
    const beginnerRun = await startAndSettle("BEGINNER");
    const expertRun = await startAndSettle("EXPERT");
    assert.equal(beginnerRun.status, "PASS");
    assert.deepEqual(expertRun, beginnerRun);
    assert.match(expertRun.evidenceBasis, /NO LOCAL MODEL INFERENCE/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("beginner surface: switcher ships with beginner default and no hash or policy identifier", async () => {
  const { server } = createLocalOperatorServer({
    root: process.cwd(),
    runner: async () => "unused",
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("ADDRESS_UNAVAILABLE");
    const html = await (await fetch("http://127.0.0.1:" + address.port)).text();
    // No sha256-style hash and no locked-control identifier anywhere in the
    // served page; the Beginner rendering clears evidence strings client-side.
    assert.doesNotMatch(html, /\b[0-9a-f]{64}\b/);
    assert.doesNotMatch(html, /security\.rego/);
    assert.doesNotMatch(html, /denyDefaultEgress/);
    // The switcher and its storage key ship on the page, server default BEGINNER.
    assert.match(html, /aria-label="Experience level"/);
    assert.match(html, new RegExp('data-level="' + DEFAULT_EXPERIENCE_LEVEL + '"'));
    assert.match(html, /alz\.experienceLevel/);
    assert.match(html, /Beginner/);
    assert.match(html, /Advanced/);
    assert.match(html, /Expert/);
    // Beginner rendering keeps one recommended action and the honest proof line.
    assert.match(html, /Explore governed scenarios/);
    assert.match(html, /Recommended/);
    assert.match(html, /Choose a workflow to see how this workspace protects you\./);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
