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
 * `ephemeral` anywhere (a block, a reference, a comment or a string) unless an `=` follows them (`*_WORD_IN_SOURCE`, a code that
 * says the match is lexical). `ephemeral = true` on a variable or an output is an ephemeral VALUE, not a resource, so it stays
 * allowed. A word in a comment or a string is therefore refused too. That fails closed: rename the comment or the string.
 *
 * A `.tf.json` file is read by `strictJson`, never `JSON.parse`: JSON.parse keeps only the last of two keys with the same name,
 * while Terraform's JSON reader keeps every block under a repeated block-type key, so two `"removed"` keys, the first carrying a
 * destroy-time `local-exec`, hid the command from both halves of the judge and Terraform ran it (review of #327, B1, reproduced
 * with real Terraform 1.16.4: test/fixtures/live/terraform/removed-duplicate-key.*). An object that repeats a key, compared after
 * escapes are decoded, is refused (`TERRAFORM_CONFIGURATION_DUPLICATE_KEY`), and so is anything that is not strict JSON. Then a
 * `provisioner` key at any depth and a top-level `ephemeral` key are refused, and the `provisioner` word rule also runs over the
 * raw text (the `ephemeral` one cannot: `"ephemeral": true` on a variable is a value). Terraform loads `.tf` and `.tf.json` files
 * only for a plan or an apply. `.tftest.hcl` and `.tfquery.hcl` are not loaded, and the suffix is compared without regard to case.
 * Codes only: nothing here quotes the project.
 */

export const PROVISIONER_NOT_ALLOWED = "TERRAFORM_PROVISIONER_NOT_ALLOWED";
export const ACTION_NOT_ALLOWED = "TERRAFORM_ACTION_NOT_ALLOWED";
export const EPHEMERAL_NOT_ALLOWED = "TERRAFORM_EPHEMERAL_RESOURCE_NOT_ALLOWED";
export const CONSTRUCTS_UNREADABLE = "TERRAFORM_CONFIGURATION_UNREADABLE";
export const CONSTRUCTS_TOO_DEEP = "TERRAFORM_CONFIGURATION_TOO_DEEP";
export const CONSTRUCTS_DUPLICATE_KEY = "TERRAFORM_CONFIGURATION_DUPLICATE_KEY";
/** The source rule's lexical matches (review of #327, N3): the word may be in a comment or a string, which `sourceRuleHint` says. */
export const PROVISIONER_WORD_IN_SOURCE = "TERRAFORM_PROVISIONER_WORD_IN_SOURCE";
export const EPHEMERAL_WORD_IN_SOURCE = "TERRAFORM_EPHEMERAL_WORD_IN_SOURCE";

/** The operator's hint for a refusal code of the source rule, or "" for any other code. */
export const sourceRuleHint = (code: string): string =>
  code === PROVISIONER_WORD_IN_SOURCE || code === EPHEMERAL_WORD_IN_SOURCE
    ? " The rule is lexical: the word may be in a comment or a string, which is refused too; rename it (docs/act-pilot-apply.md, \"Provisioners, actions and ephemeral resources\")."
    : code === CONSTRUCTS_DUPLICATE_KEY ? " A .tf.json object repeats a key, which Terraform would read as two blocks; write each block once." : "";

/**
 * What the plan judge's own refusal means, for the driver to surface at apply and cleanup instead of a generic engine failure
 * (review of #327, round 2, N2). Provider refusals are the contract's target (`TARGET_NOT_IN_CONTRACT`), as every
 * `*_NOT_IN_CONTRACT` code already is; a refused construct is an invalid artifact (`ARTIFACT_INVALID`), as at seal. Undefined for any
 * other code. Fails closed either way: the caller refuses before anything runs or is consumed.
 */
export function planJudgeRefusal(code: string): { refusal: "TARGET_NOT_IN_CONTRACT" | "ARTIFACT_INVALID"; message: string } | undefined {
  const said = (refusal: "TARGET_NOT_IN_CONTRACT" | "ARTIFACT_INVALID", why: string) => ({ refusal, message: why + " (" + code + ")." + sourceRuleHint(code) });
  if (code === "PROVIDER_NOT_ADMITTED") return said("TARGET_NOT_IN_CONTRACT", "The plan uses a provider this release does not admit (azure/azapi or hashicorp/azuread)");
  if (code === "PROVIDER_TYPE_NOT_ALLOWED") return said("TARGET_NOT_IN_CONTRACT", "The plan uses a resource type that runs code or deploys a template instead of holding a resource, which the pilot refuses");
  if ([PROVISIONER_NOT_ALLOWED, ACTION_NOT_ALLOWED, EPHEMERAL_NOT_ALLOWED, PROVISIONER_WORD_IN_SOURCE, EPHEMERAL_WORD_IN_SOURCE, CONSTRUCTS_DUPLICATE_KEY, CONSTRUCTS_UNREADABLE, CONSTRUCTS_TOO_DEEP].includes(code)) {
    return said("ARTIFACT_INVALID", "The project uses a Terraform construct the pilot refuses (a provisioner, an action, an ephemeral resource, or a .tf.json file it cannot read exactly)");
  }
  return undefined;
}

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

/** JSON nesting read before the configuration is refused as too deep, never read partially. */
const MAX_JSON_DEPTH = 256;
const ESCAPES: Readonly<Record<string, string>> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const NUMBER_OR_LITERAL = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null/y;

/**
 * Strict JSON (RFC 8259) as Terraform's JSON reader sees it: every key of every object is kept, so an object that repeats a key,
 * compared after escapes are decoded, is refused (`TERRAFORM_CONFIGURATION_DUPLICATE_KEY`) rather than silently reduced to its
 * last value as JSON.parse does. Anything else that is not strict JSON is `TERRAFORM_CONFIGURATION_UNREADABLE`. Objects have no
 * prototype, so a `__proto__` key is an ordinary key.
 */
export function strictJson(text: string): unknown {
  let at = 0;
  const unreadable = (): never => stop(CONSTRUCTS_UNREADABLE);
  const space = (): void => { while (at < text.length && (text[at] === " " || text[at] === "\t" || text[at] === "\n" || text[at] === "\r")) at++; };
  const string = (): string => {
    if (text[at] !== '"') unreadable();
    at++;
    let out = "";
    for (;;) {
      if (at >= text.length) unreadable();
      const char = text[at++]!;
      if (char === '"') return out;
      if (char < " ") unreadable();
      if (char !== "\\") { out += char; continue; }
      const escape = text[at++] ?? "";
      if (escape === "u") {
        const hex = text.slice(at, at + 4);
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) unreadable();
        out += String.fromCharCode(parseInt(hex, 16));
        at += 4;
      } else if (Object.hasOwn(ESCAPES, escape)) out += ESCAPES[escape];
      else unreadable();
    }
  };
  const value = (depth: number): unknown => {
    if (depth > MAX_JSON_DEPTH) return stop(CONSTRUCTS_TOO_DEEP);
    space();
    const char = text[at];
    if (char === "{") {
      at++;
      const object: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      space();
      if (text[at] === "}") { at++; return object; }
      for (;;) {
        space();
        const key = string();
        if (Object.hasOwn(object, key)) stop(CONSTRUCTS_DUPLICATE_KEY);
        space();
        if (text[at++] !== ":") unreadable();
        object[key] = value(depth + 1);
        space();
        const next = text[at++];
        if (next === "}") return object;
        if (next !== ",") unreadable();
      }
    }
    if (char === "[") {
      at++;
      const list: unknown[] = [];
      space();
      if (text[at] === "]") { at++; return list; }
      for (;;) {
        list.push(value(depth + 1));
        space();
        const next = text[at++];
        if (next === "]") return list;
        if (next !== ",") unreadable();
      }
    }
    if (char === '"') return string();
    NUMBER_OR_LITERAL.lastIndex = at;
    const match = NUMBER_OR_LITERAL.exec(text);
    if (!match) return unreadable();
    at += match[0].length;
    return match[0] === "true" ? true : match[0] === "false" ? false : match[0] === "null" ? null : Number(match[0]);
  };
  const result = value(0);
  space();
  if (at !== text.length) unreadable();
  return result;
}

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
      if (PROVISIONER_WORD.test(text)) stop(PROVISIONER_WORD_IN_SOURCE);
      if (EPHEMERAL_WORD.test(text)) stop(EPHEMERAL_WORD_IN_SOURCE);
      continue;
    }
    // Strict JSON first, so a repeated key cannot hide a block (B1); then the decoded keys; then the raw text's words.
    const body = strictJson(text.replace(/^\uFEFF/, ""));
    if (!isRecord(body)) return stop(CONSTRUCTS_UNREADABLE);
    if (hasProvisionerKey(body, 0)) stop(PROVISIONER_NOT_ALLOWED);
    if (Object.hasOwn(body, "ephemeral")) stop(EPHEMERAL_NOT_ALLOWED);
    if (PROVISIONER_WORD.test(text)) stop(PROVISIONER_WORD_IN_SOURCE);
  }
}
