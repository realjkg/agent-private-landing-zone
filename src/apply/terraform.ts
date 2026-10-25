import {
  INIT_ARGV, STATE_PULL_ARGV, VERSION_ARGV, WORKSPACE_SHOW_ARGV, isAllowedArgv, workspaceSelectArgv,
} from "../teardown/driver/adapters/terraform.js";
import { argvDigest } from "../teardown/driver/qualification.js";
import type { AdapterDescriptor } from "../teardown/driver/types.js";
import type { ApplyOutcome } from "./types.js";

/**
 * The apply adapter's pinned surface (docs/act-pilot-plan.md, authority items
 * 2 and 5): the exact argument lists it may run, the digest a qualification
 * record pins, and how an apply ends. The preview adapter stays unable to
 * apply; this surface is separate, so a preview qualification never activates
 * an apply and the reverse.
 *
 * Apply runs the sealed plan file and nothing else. There is no way to name a
 * resource, skip a refresh, turn locking off or approve for the operator: none
 * of those switches exists in any list below, and anything not equal to a
 * list is refused before it reaches the runner.
 */
const APPLY_ADAPTER_VERSION = "apply-1.1.0";

/** The decrypted plan sits in the private scratch directory, one level above the work directory. */
const APPLY_PLAN_ARG = "../alz-apply.tfplan";
export const APPLY_ARGV: readonly string[] = ["apply", "-input=false", "-no-color", APPLY_PLAN_ARG];

/**
 * Init for apply carries the STATE_WRITE principal in a partial backend
 * configuration (the provider's client and account settings, never a
 * secret value), so the backend settings Terraform saves name the state writer
 * and the apply itself needs only the APPLY identity. The file sits beside the
 * plan, is written 0600 and is deleted as soon as init ends. Whether Terraform
 * then really authenticates state access as STATE_WRITE and provider access as
 * APPLY is not asserted here: only a real engine can show it (G2).
 */
export const APPLY_BACKEND_CONFIG_FILE = "alz-backend.tfbackend";
export const APPLY_INIT_ARGV: readonly string[] = [...INIT_ARGV, "-backend-config=../" + APPLY_BACKEND_CONFIG_FILE];

const EXECUTABLE = "terraform";
const WORKSPACE_PLACEHOLDER = "<workspace>";
/** Of the preview adapter's lists, apply reuses only these: the pinned version and workspace steps and the read-only `state pull` that reads the serial. Its init is its own. */
const SHARED_SUBCOMMANDS = ["version", "workspace", "state"];

const sameArgv = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((arg, index) => arg === b[index]);

/**
 * Exact match: the apply list, or the pinned version, init and workspace
 * steps. Plan, show, state, destroy, import, force-unlock and every other
 * subcommand are refused, so this adapter cannot generate a plan.
 */
export function isAllowedApplyArgv(executable: string, args: readonly string[]): boolean {
  if (executable !== EXECUTABLE || !Array.isArray(args) || args.some((arg) => typeof arg !== "string")) return false;
  if (sameArgv(args, APPLY_ARGV) || sameArgv(args, APPLY_INIT_ARGV)) return true;
  return SHARED_SUBCOMMANDS.includes(args[0]) && isAllowedArgv("TERRAFORM", executable, args);
}

/** The digest a qualification record pins: every argument list this adapter can run, executable first. */
export function applyArgvDigest(): string {
  return argvDigest([
    [EXECUTABLE, ...VERSION_ARGV], [EXECUTABLE, ...APPLY_INIT_ARGV], [EXECUTABLE, ...workspaceSelectArgv(WORKSPACE_PLACEHOLDER)],
    [EXECUTABLE, ...WORKSPACE_SHOW_ARGV], [EXECUTABLE, ...STATE_PULL_ARGV], [EXECUTABLE, ...APPLY_ARGV],
  ]);
}

/** What `engineActivation` reads: engine, adapter version and argv digest. */
export const APPLY_ADAPTER: AdapterDescriptor = {
  engine: "TERRAFORM", adapterVersion: APPLY_ADAPTER_VERSION, argvDigest: applyArgvDigest(),
};

// --- the cleanup adapter --------------------------------------------------------------------------------------

/**
 * The cleanup adapter's pinned surface (docs/act-pilot-plan.md, "Cleanup of pilot-created resources"). A cleanup
 * destroys exactly the resources an approved cleanup proposal lists, nothing more: it plans a destroy limited to those
 * addresses, shows the plan to prove the list is the proposal's, and applies that plan file. The targeting is the scope
 * enforcement, not a way around review: every address comes from the approved proposal, the derived change list must
 * equal it exactly, and the apply list is the one list that runs a plan file. There is no bare destroy, no way to skip
 * a refresh, turn locking off or approve for the operator; the apply adapter above still carries no targeting at all.
 */
const CLEANUP_ADAPTER_VERSION = "cleanup-1.0.0";
/** The destroy plan sits in the private scratch directory, one level above the work directory, under its own name. */
const CLEANUP_PLAN_ARG = "../alz-cleanup.tfplan";
export const CLEANUP_PLAN_FILE = "alz-cleanup.tfplan";
/** A Terraform resource address: module path, type and name, an optional index (a number or a quoted key). Nothing else may follow the targeting flag. */
const ADDRESS = /^(?:module\.[A-Za-z0-9_-]+(?:\[(?:[0-9]+|"[A-Za-z0-9._:/-]+")\])?\.)*[a-z][a-z0-9_]*\.[A-Za-z0-9_-]+(?:\[(?:[0-9]+|"[A-Za-z0-9._:/-]+")\])?$/;
const MAX_CLEANUP_ADDRESSES = 200;
const TARGET_FLAG = "-target=";
export const isResourceAddress = (value: unknown): value is string => typeof value === "string" && value.length <= 256 && ADDRESS.test(value);

/** `plan -destroy` limited to the proposal's addresses, written to the cleanup plan file. Throws for an address outside the allowed shape. */
export function cleanupPlanArgv(addresses: readonly string[]): readonly string[] {
  if (addresses.length === 0 || addresses.length > MAX_CLEANUP_ADDRESSES || addresses.some((address) => !isResourceAddress(address))) {
    throw new Error("CLEANUP_ADDRESSES_INVALID");
  }
  return ["plan", "-destroy", "-input=false", "-no-color", ...addresses.map((address) => TARGET_FLAG + address), "-out=" + CLEANUP_PLAN_ARG];
}
export const CLEANUP_SHOW_ARGV: readonly string[] = ["show", "-json", CLEANUP_PLAN_ARG];
export const CLEANUP_APPLY_ARGV: readonly string[] = ["apply", "-input=false", "-no-color", CLEANUP_PLAN_ARG];
/** The one address the digest is computed with; a real run's addresses come from the approved proposal. */
const ADDRESS_PLACEHOLDER = "alz_placeholder.address";

/** Exact match: the targeted destroy plan (each target a resource address), its show, its apply, or the pinned version, init and workspace steps. */
export function isAllowedCleanupArgv(executable: string, args: readonly string[]): boolean {
  if (executable !== EXECUTABLE || !Array.isArray(args) || args.some((arg) => typeof arg !== "string")) return false;
  if (sameArgv(args, CLEANUP_SHOW_ARGV) || sameArgv(args, CLEANUP_APPLY_ARGV) || sameArgv(args, APPLY_INIT_ARGV)) return true;
  if (args[0] === "plan") {
    const targets = args.slice(4, -1);
    return args.length >= 6 && args[1] === "-destroy" && args[2] === "-input=false" && args[3] === "-no-color" && args[args.length - 1] === "-out=" + CLEANUP_PLAN_ARG &&
      targets.length <= MAX_CLEANUP_ADDRESSES && targets.every((arg) => arg.startsWith(TARGET_FLAG) && isResourceAddress(arg.slice(TARGET_FLAG.length)));
  }
  return SHARED_SUBCOMMANDS.includes(args[0]) && isAllowedArgv("TERRAFORM", executable, args);
}

/** The digest a qualification record pins for the cleanup adapter: every list it can run, with one placeholder address. */
export function cleanupArgvDigest(): string {
  return argvDigest([
    [EXECUTABLE, ...VERSION_ARGV], [EXECUTABLE, ...APPLY_INIT_ARGV], [EXECUTABLE, ...workspaceSelectArgv(WORKSPACE_PLACEHOLDER)],
    [EXECUTABLE, ...WORKSPACE_SHOW_ARGV], [EXECUTABLE, ...STATE_PULL_ARGV], [EXECUTABLE, ...cleanupPlanArgv([ADDRESS_PLACEHOLDER])],
    [EXECUTABLE, ...CLEANUP_SHOW_ARGV], [EXECUTABLE, ...CLEANUP_APPLY_ARGV],
  ]);
}

export const CLEANUP_ADAPTER: AdapterDescriptor = {
  engine: "TERRAFORM", adapterVersion: CLEANUP_ADAPTER_VERSION, argvDigest: cleanupArgvDigest(),
};

/**
 * The only two failures Terraform raises before it touches anything remote,
 * matched at the start of the first error summary (it draws errors in a box, so a
 * border may precede the word) and never quoted: a plan its state has outgrown,
 * and a state lock that could not be taken. `terraform apply` exits 1 for every
 * error, so the exit code cannot tell these from a failure halfway through.
 */
const FIRST_ERROR = /^[\s│╷|]*Error: (.*)$/m;
const STALE = /^Saved plan is stale/;
const LOCK_REFUSED = /^Error acquiring the state lock/;

/** What Terraform leaves in its working directory when an apply cannot persist state or crashes: the only copy of what it did, for a person to recover from. */
export const RECOVERY_FILES: readonly string[] = ["errored.tfstate", "crash.log"];

/** The state serial from `state pull` output. Undefined for anything else; the state itself is never kept. */
export function parseStateSerial(output: string): string | undefined {
  try {
    const serial = (JSON.parse(output) as { serial?: unknown }).serial;
    return typeof serial === "number" && Number.isSafeInteger(serial) && serial >= 0 ? String(serial) : undefined;
  } catch {
    return undefined;
  }
}

type ApplyEnd = { outcome: ApplyOutcome } | { stale: true };

/**
 * How an apply ended, from the exit code, the error summary and the state
 * serial read before and after (STATE identity). A non-zero exit once the apply
 * began is a partial apply for a person to review: resources can be created
 * while the state write fails (the serial then does not move, and Terraform
 * leaves errored.tfstate). Only the first `Error:` diagnostic is read: a provider error body can quote any
 * later text, so a refusal quoted after other output proves nothing. Only two refusals are known to precede any change:
 * a stale plan (PLAN_STALE) and a state lock that was not acquired
 * (FAILED_NO_CHANGE), and only when the serial did not move. A run that was
 * stopped, or ended by a signal, is KILLED unless it had already succeeded.
 * No engine text is carried out.
 */
export function classifyApply(run: {
  exitCode: number | null; stderr: string; serialBefore: string; serialAfter: string | undefined;
  /** A stop was requested (kill switch, time limit or signal). Terraform's graceful stop exits non-zero, so the code alone would read as a plain failure. */
  stopped?: boolean;
}): ApplyEnd {
  if (run.exitCode === 0) return { outcome: "SUCCEEDED" };
  if (run.exitCode === null || run.stopped) return { outcome: "KILLED" };
  if (run.serialAfter !== run.serialBefore) return { outcome: "PARTIAL_REQUIRES_REVIEW" };
  const first = FIRST_ERROR.exec(run.stderr)?.[1] ?? "";
  if (STALE.test(first)) return { stale: true };
  return LOCK_REFUSED.test(first) ? { outcome: "FAILED_NO_CHANGE" } : { outcome: "PARTIAL_REQUIRES_REVIEW" };
}
