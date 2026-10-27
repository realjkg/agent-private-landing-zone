import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha256 } from "../util/sha256.js";
import { stop } from "./engine.js";

/**
 * The backend pin (docs/act-pilot-apply.md, "The backend rule"; docs/act-pilot-backend-pinning.md). The project's own
 * backend block is never read or judged. Instead the frozen work copy gets one product-owned Terraform override file
 * that names only the provider's backend type, and every setting comes from the product's `-backend-config` file.
 * Terraform merges override files last and replaces the backend wholesale (it also drops any `cloud` or `state_store`
 * block), even when other files fail to parse, so init can only build our backend or fail before it contacts any.
 *
 * Two things could still outrank or bypass the pin, and both are refused by NAME before init: another override file
 * (Terraform merges those in name order, so one sorting after ours would win), and saved workspace state (a `.terraform`
 * directory or a local state file init could read or migrate from).
 */

/** The one product-owned override file. Its name ends in `_override.tf`, so Terraform treats it as an override. */
export const BACKEND_OVERRIDE_FILE = "zzzz_alz_backend_override.tf";

/** The backend types a provider spec may pin. Nothing else is ever written into the override. */
export type BackendType = "s3" | "azurerm";
const BACKEND_TYPES: readonly string[] = ["s3", "azurerm"];

/** Saved state or a data directory in the root that init could read, reuse or migrate from. */
const STATE_NAMES = new Set([".terraform", "terraform.tfstate", "terraform.tfstate.backup", "terraform.tfstate.d"]);

/**
 * Terraform's override rule (parser_file_matcher.go): `override.tf(.json)` or `*_override.tf(.json)`. Matched
 * case-insensitively here, which only ever refuses more than Terraform would merge.
 */
export function isOverrideName(name: string): boolean {
  const lower = name.toLowerCase();
  for (const extension of [".tf.json", ".tf"]) {
    if (!lower.endsWith(extension)) continue;
    const base = lower.slice(0, -extension.length);
    return base === "override" || base.endsWith("_override");
  }
  return false;
}

/**
 * Refuses, by name only and whatever the entry is (file, directory or link), any root entry that is an override file
 * (BACKEND_OVERRIDE_NOT_ALLOWED) or saved workspace state (WORKSPACE_STATE_NOT_ALLOWED). Run on the frozen work copy
 * before the product override is written and before any init.
 */
export function assertNoBackendOverrideOrState(directory: string): void {
  for (const name of readdirSync(directory)) {
    if (isOverrideName(name)) stop("BACKEND_OVERRIDE_NOT_ALLOWED");
    if (STATE_NAMES.has(name.toLowerCase())) stop("WORKSPACE_STATE_NOT_ALLOWED");
  }
}

/** The override file's exact content: the backend type and nothing else. */
export function backendOverride(type: BackendType): string {
  if (!BACKEND_TYPES.includes(type)) return stop("BACKEND_TYPE_NOT_IN_CONTRACT");
  return `terraform {\n  backend "${type}" {}\n}\n`;
}

/** Writes the override into the work copy (never over an existing file) and returns its manifest entry, so the copy stays bound. */
export function writeBackendOverride(directory: string, type: BackendType): { path: string; sha256: string } {
  const content = backendOverride(type);
  writeFileSync(join(directory, BACKEND_OVERRIDE_FILE), content, { mode: 0o600, flag: "wx" });
  return { path: BACKEND_OVERRIDE_FILE, sha256: sha256(content) };
}

/** Refusals of the project's own layout that mean the target is not the contract's: mapped like the `*_NOT_IN_CONTRACT` codes, so nothing is spent. */
export const isBackendPinRefusal = (code: string): boolean => code === "BACKEND_OVERRIDE_NOT_ALLOWED" || code === "WORKSPACE_STATE_NOT_ALLOWED";
