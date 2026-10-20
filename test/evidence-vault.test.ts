import {
  randomBytes,
} from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decryptEvidence,
  encryptEvidence,
  ensureEvidenceKey,
} from "../src/evidence/vault.js";

test("evidence vault encrypts and decrypts without exposing plaintext", () => {
  const key = randomBytes(32);
  const secret =
    "sensitive-control-evidence";

  const envelope = encryptEvidence(
    "test",
    {
      value: secret,
    },
    key,
  );

  assert.equal(
    JSON.stringify(envelope).includes(
      secret,
    ),
    false,
  );

  const value =
    decryptEvidence<{
      value: string;
    }>(
      envelope,
      key,
    );

  assert.equal(
    value.value,
    secret,
  );
});

test("evidence vault rejects tampered ciphertext", () => {
  const key = randomBytes(32);
  const envelope = encryptEvidence(
    "test",
    { value: "evidence" },
    key,
  );

  const tampered = {
    ...envelope,
    ciphertext:
      envelope.ciphertext.slice(0, -4) +
      "AAAA",
  };

  assert.throws(
    () =>
      decryptEvidence(
        tampered,
        key,
      ),
  );
});

test("concurrent first-use key creation atomically publishes a complete single key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alz-key-race-"));
  const previous = process.env.AGENTIC_EVIDENCE_KEY_FILE;
  const previousInline = process.env.AGENTIC_EVIDENCE_KEY;
  const path = join(dir, "evidence.key");
  try {
    process.env.AGENTIC_EVIDENCE_KEY_FILE = path;
    delete process.env.AGENTIC_EVIDENCE_KEY;
    const values = await Promise.all(Array.from({ length: 32 }, () => ensureEvidenceKey()));
    const raw = (await readFile(path, "utf8")).trim();
    assert.equal(Buffer.from(raw, "base64").length, 32);
    assert.ok(values.every(item => item.key.equals(values[0].key)));
    assert.deepEqual(await readdir(dir), ["evidence.key"]);
  } finally {
    if (previous === undefined) delete process.env.AGENTIC_EVIDENCE_KEY_FILE;
    else process.env.AGENTIC_EVIDENCE_KEY_FILE = previous;
    if (previousInline === undefined) delete process.env.AGENTIC_EVIDENCE_KEY;
    else process.env.AGENTIC_EVIDENCE_KEY = previousInline;
    await rm(dir, { recursive: true, force: true });
  }
});
