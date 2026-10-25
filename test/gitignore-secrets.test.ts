import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

// Private keys and certificates must stay out of Git. The check reads the rules as text, so it needs no git binary.
const rules = readFileSync(resolve(import.meta.dirname, "..", ".gitignore"), "utf8")
  .split("\n")
  .map((line) => line.trim());

test("private key and certificate formats are ignored", () => {
  for (const pattern of ["*.pem", "*.key", "*.p12", "*.pfx", "*.jks"]) {
    assert.ok(rules.includes(pattern), pattern + " must be ignored");
  }
});

test("the environment template stays tracked", () => {
  assert.ok(rules.includes("!.env.example"), "!.env.example must keep the template tracked");
});
