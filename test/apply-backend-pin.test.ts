import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BACKEND_OVERRIDE_FILE, assertNoBackendOverrideOrState, backendOverride, isBackendPinRefusal, isOverrideName, writeBackendOverride, type BackendType,
} from "../src/apply/backend-pin.js";
import { codeOf } from "../src/apply/engine.js";
import { AWS } from "../src/apply/providers/aws.js";
import { AZURE } from "../src/apply/providers/azure.js";
import { sha256 } from "../src/util/sha256.js";

// docs/act-pilot-backend-pinning.md. The project's backend block is never read: one product-owned override file pins the
// backend type, and any root entry that could outrank it or feed init saved state is refused by name. No engine runs here.

const verdict = (make: (dir: string) => void): string => {
  const dir = mkdtempSync(join(tmpdir(), "alz-backend-pin-"));
  try {
    make(dir);
    try { assertNoBackendOverrideOrState(dir); return "ok"; } catch (error) { return codeOf(error); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
};
const file = (name: string) => (dir: string) => writeFileSync(join(dir, name), 'terraform {\n  backend "http" {}\n}\n');
const folder = (name: string) => (dir: string) => mkdirSync(join(dir, name));
const link = (name: string) => (dir: string) => symlinkSync("/nonexistent", join(dir, name));

test("Terraform's override names, in any letter case, are refused whether file, folder or link", () => {
  const names = [
    "override.tf", "override.tf.json", "backend_override.tf", "main_override.tf.json", "_override.tf", "a_b_override.tf",
    "Override.tf", "OVERRIDE.TF", "Main_Override.Tf.Json", "x_OVERRIDE.tf", BACKEND_OVERRIDE_FILE,
  ];
  for (const name of names) {
    assert.equal(isOverrideName(name), true, name);
    for (const make of [file, folder, link]) assert.equal(verdict(make(name)), "BACKEND_OVERRIDE_NOT_ALLOWED", name + " " + make.name);
  }
});

test("names Terraform does not treat as overrides pass", () => {
  for (const name of ["main.tf", "override.tfvars", "override.tf.bak", "override.tf~", "overrides.tf", "myoverride.tf", "override-x.tf", "override", ".override.tf.swp", "variables.tf.json"]) {
    assert.equal(isOverrideName(name), false, name);
    assert.equal(verdict(file(name)), "ok", name);
  }
  assert.equal(verdict(() => undefined), "ok", "an empty root");
});

test("saved workspace state or a data directory in the root is refused by name, whatever it is", () => {
  for (const name of [".terraform", "terraform.tfstate", "terraform.tfstate.backup", "terraform.tfstate.d", ".Terraform", "TERRAFORM.TFSTATE"]) {
    for (const make of [file, folder, link]) assert.equal(verdict(make(name)), "WORKSPACE_STATE_NOT_ALLOWED", name + " " + make.name);
  }
});

test("the override names only the backend type, is written once after the copy, and its manifest entry binds its bytes", () => {
  assert.equal(backendOverride("s3"), 'terraform {\n  backend "s3" {}\n}\n');
  assert.equal(backendOverride("azurerm"), 'terraform {\n  backend "azurerm" {}\n}\n');
  assert.equal(codeOf((() => { try { backendOverride("http" as BackendType); } catch (error) { return error; } })()), "BACKEND_TYPE_NOT_IN_CONTRACT");
  const dir = mkdtempSync(join(tmpdir(), "alz-backend-pin-"));
  try {
    const entry = writeBackendOverride(dir, "s3");
    assert.deepEqual(entry, { path: BACKEND_OVERRIDE_FILE, sha256: sha256(backendOverride("s3")) });
    assert.equal(readFileSync(join(dir, BACKEND_OVERRIDE_FILE), "utf8"), backendOverride("s3"));
    assert.equal(statSync(join(dir, BACKEND_OVERRIDE_FILE)).mode & 0o777, 0o600);
    assert.throws(() => writeBackendOverride(dir, "s3"), /EEXIST/, "never over an existing file");
    assert.equal(verdict((d) => writeBackendOverride(d, "s3")), "BACKEND_OVERRIDE_NOT_ALLOWED", "the product's own name arriving from the project is refused too");
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // Sorted after any project name Terraform would merge before it, so it is also last among overrides (none may exist).
  assert.ok(BACKEND_OVERRIDE_FILE > "main_override.tf");
});

test("each provider pins its own type, and its backend file holds the contract's location", () => {
  assert.equal(AWS.backendType, "s3");
  assert.equal(AZURE.backendType, "azurerm");
  assert.equal(AWS.backendLocation({ accountId: "111111111111", region: "us-east-1", backend: "examplefake-dev-state/pilot/dev.tfstate", workspace: "default" } as never),
    'bucket = "examplefake-dev-state"\nkey = "pilot/dev.tfstate"\nregion = "us-east-1"\nuse_lockfile = true\n');
  assert.equal(AZURE.backendLocation({ tenantId: "x", subscriptionId: "y", backend: "acct01/tfstate/pilot/dev.tfstate", workspace: "default" } as never),
    'storage_account_name = "acct01"\ncontainer_name = "tfstate"\nkey = "pilot/dev.tfstate"\nuse_azuread_auth = true\n');
  for (const backend of ['bucket"/x', "a/../b", ""]) {
    assert.throws(() => AWS.backendLocation({ accountId: "111111111111", region: "us-east-1", backend, workspace: "default" } as never), /BACKEND_NOT_IN_CONTRACT/, backend);
    assert.throws(() => AZURE.backendLocation({ tenantId: "x", subscriptionId: "y", backend, workspace: "default" } as never), /BACKEND_NOT_IN_CONTRACT/, backend);
  }
});

test("the pin's refusals are contract refusals: nothing is spent", () => {
  assert.equal(isBackendPinRefusal("BACKEND_OVERRIDE_NOT_ALLOWED"), true);
  assert.equal(isBackendPinRefusal("WORKSPACE_STATE_NOT_ALLOWED"), true);
  assert.equal(isBackendPinRefusal("ARGV_NOT_ALLOWED"), false);
});
