import {
  randomBytes,
} from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import {
  decryptEvidence,
  encryptEvidence,
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
