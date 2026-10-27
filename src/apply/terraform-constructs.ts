import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { stop } from "./engine.js";

/**
 * Terraform constructs the pilot refuses on every Terraform path (seal, apply and cleanup), whatever the provider, because each one
 * reaches past the reviewed change list (review 6453264963 of #322, N2):
 *
 * - `provisioner` blocks (`local-exec`, `remote-exec`, `file`, on any resource, `terraform_data` and `null_resource` included).
 *   At apply they run commands on the runner, or on a host it reaches, with APPLY's credentials in the environment.
 * - `action` blocks and their invocations (Terraform 1.14+). An action calls a provider operation at apply (`aws_lambda_invoke`,
 *   `aws_sns_publish`, `aws_ec2_stop_instance` and more), which is outside the resource changes the approvers read.
 * - `ephemeral` resources. They are opened at plan (as DISCOVERY) and at apply (as APPLY). Many read secrets or mint tokens
 *   (`aws_secretsmanager_secret_version`, `aws_ssm_parameter`, `aws_kms_secrets`, `aws_eks_cluster_auth`,
 *   `aws_lambda_invocation`), and none of them appears in the change list.
 *
 * Where each one is seen. This was checked against real Terraform 1.16.4 and hashicorp/aws 6.68.0, on 2026-10-27:
 *
 * - Provisioners on a resource and actions: `terraform show -json` of a saved plan lists them. Provisioners are under
 *   `configuration.root_module.resources[].provisioners`, and actions under `configuration.root_module.actions[]`, in every module
 *   through `module_calls`. The invocations are under the top-level `action_invocations[]`. `assertNoRefusedPlanConstructs` reads them.
 * - Provisioners in a `removed` block (Terraform 1.9+, `when = destroy`): `show -json` does NOT list them, nor the `removed` block.
 *   The plan shows an ordinary delete (`delete_because_no_resource_config`), and the apply would still run the command.
 * - Ephemeral resources: `show -json` does NOT list them. They are not in `configuration` (which lists managed and data resources
 *   only), `resource_changes`, `planned_values` or the state.
 *
 * So `assertNoRefusedSourceConstructs` also reads the project's Terraform files, in the bound work copy, before init and before any
 * plan opens one, at seal, at apply and at cleanup (the saved plan carries this same configuration). It refuses every `provisioner`
 * block and every `ephemeral` block. The plan check still refuses any resource whose mode is `ephemeral`, in case a later
 * `show -json` starts listing them.
 *
 * The limit of the source rule: it is a lexical rule, not an HCL parser. In a `.tf` file it refuses the words `provisioner` and
 * `ephemeral` anywhere (a block, a reference, a comment or a string) unless an `=` follows them. `ephemeral = true` on a variable or
 * an output is an ephemeral VALUE, not a resource, so it stays allowed. A word in a comment or a string is therefore refused too.
 * That fails closed: rename the comment or the string. In a `.tf.json` file it parses the JSON and refuses a top-level `ephemeral`
 * key and a `provisioner` key at any depth. A file that does not parse is refused. Terraform loads `.tf` and `.tf.json` files only
 * for a plan or an apply. `.tftest.hcl` and `.tfquery.hcl` are not loaded, and the suffix is compared without regard to case.
 * Codes only: nothing here quotes the project.
 */

export const PROVISIONER_NOT_ALLOWED = "TERRAFORM_PROVISIONER_NOT_ALLOWED";
export const ACTION_NOT_ALLOWED = "TERRAFORM_ACTION_NOT_ALLOWED";
export const EPHEMERAL_NOT_ALLOWED = "TERRAFORM_EPHEMERAL_RESOURCE_NOT_ALLOWED";
export const CONSTRUCTS_UNREADABLE = "TERRAFORM_CONFIGURATION_UNREADABLE";
export const CONSTRUCTS_TOO_DEEP = "TERRAFORM_CONFIGURATION_TOO_DEEP";

/** Module nesting followed, as the provider walker does; past it the configuration is refused, never read partially. */
const MAX_DEPTH = 64;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** A list that is present must be a list. Absent is empty. */
const listOf = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : stop(CONSTRUCTS_UNREADABLE);
const EPHEMERAL_ADDRESS = /(^|\.)ephemeral\./;

/**
 * The plan half: `document` is the parsed `terraform show -json` of a saved plan. Refuses any provisioner, any declared action,
 * any action invocation and any ephemeral resource, in the root module and in every module below it. A tree that is present but
 * not the documented shape is `TERRAFORM_CONFIGURATION_UNREADABLE`, because a construct that could not be read could be one of these.
 */
export function assertNoRefusedPlanConstructs(document: unknown): void {
  if (!isRecord(document)) return stop(CONSTRUCTS_UNREADABLE);
  for (const key of ["action_invocations", "deferred_action_invocations"]) if (listOf(document[key]).length > 0) stop(ACTION_NOT_ALLOWED);
  for (const change of listOf(document.resource_changes)) {
    if (!isRecord(change)) return stop(CONSTRUCTS_UNREADABLE);
    if (isEphemeral(change)) stop(EPHEMERAL_NOT_ALLOWED);
  }
  const configuration = document.configuration;
  if (configuration === undefined) return;
  if (!isRecord(configuration)) return stop(CONSTRUCTS_UNREADABLE);
  const walk = (module: unknown, depth: number): void => {
    if (module === undefined) return;
    if (!isRecord(module)) return stop(CONSTRUCTS_UNREADABLE);
    if (depth > MAX_DEPTH) return stop(CONSTRUCTS_TOO_DEEP);
    if (listOf(module.actions).length > 0) stop(ACTION_NOT_ALLOWED);
    for (const resource of listOf(module.resources)) {
      if (!isRecord(resource)) return stop(CONSTRUCTS_UNREADABLE);
      if (listOf(resource.provisioners).length > 0) stop(PROVISIONER_NOT_ALLOWED);
      if (isEphemeral(resource)) stop(EPHEMERAL_NOT_ALLOWED);
    }
    const calls = module.module_calls;
    if (calls === undefined) return;
    if (!isRecord(calls)) return stop(CONSTRUCTS_UNREADABLE);
    for (const call of Object.values(calls)) {
      if (!isRecord(call)) return stop(CONSTRUCTS_UNREADABLE);
      walk(call.module, depth + 1);
    }
  };
  walk(configuration.root_module, 0);
}

const isEphemeral = (entry: Record<string, unknown>): boolean =>
  (typeof entry.mode === "string" && entry.mode.toLowerCase() === "ephemeral") || (typeof entry.address === "string" && EPHEMERAL_ADDRESS.test(entry.address));

/** The word, not part of a longer identifier, and not an attribute name (`ephemeral = true`). */
const wordRule = (word: string): RegExp => new RegExp("(?<![A-Za-z0-9_-])" + word + "(?![A-Za-z0-9_-])(?!\\s*=(?!=))");
const EPHEMERAL_WORD = wordRule("ephemeral");
const PROVISIONER_WORD = wordRule("provisioner");

/** True when `provisioner` is a key anywhere in the JSON tree. A resource and a `removed` block both carry it below the top level. */
const hasProvisionerKey = (value: unknown, depth: number): boolean => {
  if (depth > MAX_DEPTH) return stop(CONSTRUCTS_TOO_DEEP);
  if (Array.isArray(value)) return value.some((item) => hasProvisionerKey(item, depth + 1));
  if (!isRecord(value)) return false;
  return Object.hasOwn(value, "provisioner") || Object.values(value).some((item) => hasProvisionerKey(item, depth + 1));
};

/**
 * The source half: refuses a `provisioner` or an `ephemeral` block in any `.tf` or `.tf.json` file under `work`, at any depth. `work` is the copy
 * bound to the manifest before init, so it holds every local module (remote modules are refused, `MODULE_SOURCE_NOT_LOCAL`).
 * Every directory is read, including the ones the manifest does not capture: a module there is still loaded by Terraform.
 * Anything that is not a directory or a regular file is refused (`copyTree` copies neither).
 */
export function assertNoRefusedSourceConstructs(work: string, depth = 0): void {
  if (depth > MAX_DEPTH) return stop(CONSTRUCTS_TOO_DEEP);
  let names: string[];
  try { names = readdirSync(work).sort(); } catch { return stop(CONSTRUCTS_UNREADABLE); }
  for (const name of names) {
    const path = join(work, name);
    let kind: "dir" | "file" | "other";
    try {
      const stat = lstatSync(path);
      kind = stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other";
    } catch { return stop(CONSTRUCTS_UNREADABLE); }
    if (kind === "other") return stop(CONSTRUCTS_UNREADABLE);
    if (kind === "dir") { assertNoRefusedSourceConstructs(path, depth + 1); continue; }
    const lower = name.toLowerCase();
    if (!lower.endsWith(".tf") && !lower.endsWith(".tf.json")) continue;
    let text: string;
    try { text = readFileSync(path, "utf8"); } catch { return stop(CONSTRUCTS_UNREADABLE); }
    if (lower.endsWith(".tf")) {
      if (PROVISIONER_WORD.test(text)) stop(PROVISIONER_NOT_ALLOWED);
      if (EPHEMERAL_WORD.test(text)) stop(EPHEMERAL_NOT_ALLOWED);
      continue;
    }
    let body: unknown;
    try { body = JSON.parse(text.replace(/^﻿/, "")); } catch { return stop(CONSTRUCTS_UNREADABLE); }
    if (!isRecord(body)) return stop(CONSTRUCTS_UNREADABLE);
    if (hasProvisionerKey(body, 0)) stop(PROVISIONER_NOT_ALLOWED);
    if (Object.hasOwn(body, "ephemeral")) stop(EPHEMERAL_NOT_ALLOWED);
  }
}
