import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { requiredModels } from "../src/models/catalog.js";
import { checkModelDigest, isExactModelTag, loadModelDigestPins, MODEL_PINS_PATH, normalizeDigest, verifyPinnedModel } from "../src/models/digest-pins.js";
import { getLocalModelMetadata, invokeLocalModel, isLoopbackModelEndpoint } from "../src/ollama.js";

// RB4 (exact model versions) and the loopback rule of the model client. SYNTHETIC: a fake /api/tags on 127.0.0.1.

const ORIGINAL_PINS = readFileSync(MODEL_PINS_PATH, "utf8");

test("the release pins name exact tags only, one digest slot per release model, and match the role defaults and the catalog", () => {
  const pins = loadModelDigestPins();
  assert.deepEqual([...pins.models], ["qwen3:1.7b", "qwen3:4b", "mistral-nemo:12b"]);
  assert.ok(pins.models.every(isExactModelTag), "no :latest and no bare name");
  assert.doesNotMatch(ORIGINAL_PINS, /:latest"/, "the pin file names no :latest tag");
  assert.deepEqual([...pins.digests.keys()].sort(), [...pins.models].sort());
  for (const [model, digest] of pins.digests) assert.ok(digest === null || /^[0-9a-f]{64}$/.test(digest), model);
  // The source is recorded beside the values, so the owner input says where each digest comes from.
  const raw = JSON.parse(ORIGINAL_PINS) as { isolatedOllama: { modelDigestSource: string } };
  assert.match(raw.isolatedOllama.modelDigestSource, /^https:\/\/registry\.ollama\.ai\/v2\/library\/<name>\/manifests\/<tag> /);
  // The role defaults and the required catalog entries are the release models.
  const saved = { ROUTER_MODEL: process.env.ROUTER_MODEL, PRIMARY_MODEL: process.env.PRIMARY_MODEL, VALIDATOR_MODEL: process.env.VALIDATOR_MODEL };
  delete process.env.ROUTER_MODEL; delete process.env.PRIMARY_MODEL; delete process.env.VALIDATOR_MODEL;
  try {
    const cfg = loadConfig();
    assert.deepEqual([cfg.routerModel, cfg.primaryModel, cfg.validatorModel], ["qwen3:1.7b", "qwen3:4b", "mistral-nemo:12b"]);
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
  }
  assert.deepEqual(requiredModels().map((item) => item.model), [...pins.models]);
});

test("a pin file with :latest, a missing slot or a malformed digest is refused as a whole", () => {
  const dir = mkdtempSync(join(tmpdir(), "alz-model-pins-"));
  try {
    const write = (isolatedOllama: unknown) => {
      const path = join(dir, "pins.json");
      writeFileSync(path, JSON.stringify({ isolatedOllama }));
      return path;
    };
    assert.throws(() => loadModelDigestPins(write({ models: ["mistral-nemo:latest"], modelDigests: { "mistral-nemo:latest": null } })), /MODEL_PINS_INVALID/);
    assert.throws(() => loadModelDigestPins(write({ models: ["qwen3"], modelDigests: { qwen3: null } })), /MODEL_PINS_INVALID/);
    assert.throws(() => loadModelDigestPins(write({ models: ["qwen3:4b", "qwen3:1.7b"], modelDigests: { "qwen3:4b": null } })), /exactly the release models/);
    assert.throws(() => loadModelDigestPins(write({ models: ["qwen3:4b"], modelDigests: { "qwen3:4b": "sha256:" + "a".repeat(64) } })), /64 lowercase hex/);
    assert.throws(() => loadModelDigestPins(write({ models: ["qwen3:4b"] })), /modelDigests is missing/);
    const good = loadModelDigestPins(write({ models: ["qwen3:4b"], modelDigests: { "qwen3:4b": "a".repeat(64) } }));
    assert.equal(good.digests.get("qwen3:4b"), "a".repeat(64));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the digest check passes only an exact match; a missing pin, a missing digest or a different one is refused", () => {
  const pins = { models: ["qwen3:4b", "mistral-nemo:12b"], digests: new Map<string, string | null>([["qwen3:4b", "a".repeat(64)], ["mistral-nemo:12b", null]]) };
  assert.deepEqual(checkModelDigest("qwen3:4b", "sha256:" + "A".repeat(64), pins), { ok: true, model: "qwen3:4b", digest: "a".repeat(64) });
  const mismatch = checkModelDigest("qwen3:4b", "b".repeat(64), pins);
  assert.ok(!mismatch.ok && mismatch.code === "MODEL_DIGEST_MISMATCH" && mismatch.observed === "b".repeat(64));
  const open = checkModelDigest("mistral-nemo:12b", "a".repeat(64), pins);
  assert.ok(!open.ok && open.code === "MODEL_DIGEST_UNPINNED" && /owner input/.test(open.message));
  const offList = checkModelDigest("qwen3:8b", "a".repeat(64), pins);
  assert.ok(!offList.ok && offList.code === "MODEL_DIGEST_UNPINNED");
  const blank = checkModelDigest("qwen3:4b", "", pins);
  assert.ok(!blank.ok && blank.code === "MODEL_DIGEST_INVALID");
  assert.equal(normalizeDigest("sha256:" + "f".repeat(64)), "f".repeat(64));
  assert.equal(normalizeDigest("f".repeat(63)), undefined);
});

test("verify reads the installed digest from the loopback model server and refuses a mismatch before any qualification", async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/tags");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ models: [
      { name: "qwen3:4b", model: "qwen3:4b", digest: "a".repeat(64), size: 10 },
      { name: "mistral-nemo:12b", model: "mistral-nemo:12b", digest: "c".repeat(64), size: 20 },
    ] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const baseUrl = "http://127.0.0.1:" + address.port;
    const pins = { models: ["qwen3:4b", "mistral-nemo:12b"], digests: new Map<string, string | null>([["qwen3:4b", "a".repeat(64)], ["mistral-nemo:12b", "b".repeat(64)]]) };
    const pinned = await verifyPinnedModel(baseUrl, "qwen3:4b", pins);
    assert.ok(pinned.check.ok);
    const drifted = await verifyPinnedModel(baseUrl, "mistral-nemo:12b", pins);
    assert.ok(!drifted.check.ok && drifted.check.code === "MODEL_DIGEST_MISMATCH");
    await assert.rejects(verifyPinnedModel(baseUrl, "qwen3:1.7b", pins), /MODEL_NOT_INSTALLED/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the models CLI checks the digest pin before it qualifies a model", () => {
  const cli = readFileSync("src/cli/models.ts", "utf8");
  const pinCheck = cli.indexOf("verifyPinnedModel(");
  const qualify = cli.indexOf("await qualifyModel(");
  assert.ok(pinCheck > 0 && qualify > pinCheck, "verifyPinnedModel runs before qualifyModel");
  assert.match(cli.slice(pinCheck, qualify), /if \(!check\.ok\) \{[\s\S]*failed = true;[\s\S]*continue;/);
  assert.doesNotMatch(cli, /getLocalModelMetadata/, "no unpinned metadata path remains");
});

test("loopback only: the model client refuses a non-loopback OLLAMA_BASE_URL before any request, with no fallback", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; throw new Error("FETCH_MUST_NOT_RUN"); }) as typeof fetch;
  try {
    for (const baseUrl of ["https://api.openai.com", "http://10.0.0.5:11434", "https://127.0.0.1:11434", "http://user:pw@127.0.0.1:11434",
      "http://ollama.example.com:11434", "http://127.0.0.1.nip.io:11434", "not a url"]) {
      await assert.rejects(invokeLocalModel(baseUrl, "qwen3:4b", [{ role: "user", content: "hi" }]),
        (error: Error) => /^MODEL_ENDPOINT_NOT_LOOPBACK: BLOCKED\./.test(error.message) && !error.message.includes(baseUrl), baseUrl);
      await assert.rejects(getLocalModelMetadata(baseUrl, "qwen3:4b"), /^Error: MODEL_ENDPOINT_NOT_LOOPBACK: BLOCKED/, baseUrl);
    }
    assert.equal(calls, 0, "nothing was sent anywhere");
  } finally {
    globalThis.fetch = realFetch;
  }
  for (const baseUrl of ["http://127.0.0.1:11434", "http://localhost:11435", "http://[::1]:11434"]) assert.ok(isLoopbackModelEndpoint(baseUrl), baseUrl);
});
