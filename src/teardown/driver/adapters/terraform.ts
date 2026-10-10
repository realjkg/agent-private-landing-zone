import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { createChangeSet, type ResourceChange } from "../../../iac/changeset.js";
import { normalizeOpenTofuPlan, normalizeTerraformPlan } from "../../../iac/terraform-plan.js";
import { runBoundedProcess } from "../../../tools/process.js";
import { PROFILES, type ProcessProfile } from "../../../tools/profiles.js";
import type { ArtifactManifest, StateVersionRecord } from "../../manifest.js";
import { removeTree } from "../cleanup.js";
import { buildEvidence } from "../evidence.js";
import { argvDigest } from "../qualification.js";
import { copyTree, projectDifference } from "./project-copy.js";
import type {
  AdapterContext,
  EngineAdapter,
  PreviewEvidence,
  PreviewOperation,
  PreviewRequest,
} from "../types.js";

/**
 * One adapter for Terraform and OpenTofu (docs/destroy-preview-driver.md,
 * "Terraform and OpenTofu adapter"). The two engines share an argument list;
 * they differ only by executable name, and each has its own profile in
 * src/tools/profiles.ts.
 *
 * It runs in the driver's private scratch directory, never in the read-only
 * snapshot: the snapshot is copied to a writable work directory, the plan file
 * is written beside it, and both are deleted before the adapter returns.
 * Locking stays on (no -lock flag exists in any argument list below).
 */
export const ADAPTER_VERSION = "1.0.0";

export type TerraformEngine = "TERRAFORM" | "OPENTOFU";
const EXECUTABLE: Readonly<Record<TerraformEngine, string>> = { TERRAFORM: "terraform", OPENTOFU: "tofu" };

const PLAN_FILE_NAME = "alz-preview.tfplan";
/** The work directory is a child of the scratch directory, so `..` is the private directory itself. */
const PLAN_FILE_ARG = "../" + PLAN_FILE_NAME;

/**
 * The exact argument lists, per operation. Anything not equal to one of these
 * is refused before it reaches the runner (see isAllowedArgv).
 */
export const VERSION_ARGV: readonly string[] = ["version", "-json"];
/** `-lockfile=readonly`: init cannot change the dependency lock file. */
export const INIT_ARGV: readonly string[] = ["init", "-input=false", "-no-color", "-lockfile=readonly"];
export const WORKSPACE_SHOW_ARGV: readonly string[] = ["workspace", "show"];
/** The workspace name is the one parameter; it is validated by WORKSPACE_NAME. */
export const workspaceSelectArgv = (workspace: string): readonly string[] => ["workspace", "select", workspace];
export const STATE_PULL_ARGV: readonly string[] = ["state", "pull"];
export const PREVIEW_PLAN_ARGV: readonly string[] = ["plan", "-input=false", "-no-color", "-out=" + PLAN_FILE_ARG];
/** The only argument list in the codebase that contains -destroy. It plans a destroy; it never runs one. */
export const DESTROY_PREVIEW_PLAN_ARGV: readonly string[] = [
  "plan", "-destroy", "-input=false", "-no-color", "-out=" + PLAN_FILE_ARG,
];
export const SHOW_ARGV: readonly string[] = ["show", "-json", PLAN_FILE_ARG];

const WORKSPACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,89}$/;
const WORKSPACE_PLACEHOLDER = "<workspace>";

const sameArgv = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((arg, index) => arg === b[index]);

/** Exact match against the one destroy-preview plan argv for this engine. */
export function isAllowedDestroyPreviewArgv(engine: TerraformEngine, executable: string, args: readonly string[]): boolean {
  return executable === EXECUTABLE[engine] && sameArgv(args, DESTROY_PREVIEW_PLAN_ARGV);
}

/**
 * Exact match against every argument list this adapter runs. There is no
 * pattern: an extra flag, a different subcommand (apply, destroy, state rm,
 * force-unlock, import, taint ...), a lock switch or the other engine's
 * executable is refused.
 */
export function isAllowedArgv(engine: TerraformEngine, executable: string, args: readonly string[]): boolean {
  if (executable !== EXECUTABLE[engine] || args.some((arg) => typeof arg !== "string")) return false;
  if (args.length === 3 && args[0] === "workspace" && args[1] === "select") return WORKSPACE_NAME.test(args[2]);
  return [VERSION_ARGV, INIT_ARGV, WORKSPACE_SHOW_ARGV, STATE_PULL_ARGV, PREVIEW_PLAN_ARGV, DESTROY_PREVIEW_PLAN_ARGV, SHOW_ARGV]
    .some((allowed) => sameArgv(args, allowed));
}

/** The digest a qualification record pins: every argument list this adapter can run, executable first. */
export function terraformArgvDigest(engine: TerraformEngine): string {
  const exe = EXECUTABLE[engine];
  return argvDigest([
    [exe, ...VERSION_ARGV], [exe, ...INIT_ARGV], [exe, ...workspaceSelectArgv(WORKSPACE_PLACEHOLDER)],
    [exe, ...WORKSPACE_SHOW_ARGV], [exe, ...STATE_PULL_ARGV], [exe, ...PREVIEW_PLAN_ARGV],
    [exe, ...DESTROY_PREVIEW_PLAN_ARGV], [exe, ...SHOW_ARGV],
  ]);
}

const MIB = 1024 * 1024;
/**
 * The runner's default profile caps output at 1 MiB, which a real
 * `show -json` of a large destroy plan (thousands of resources, each with its
 * full before-state) exceeds. `show` and `state pull` get this derived profile
 * with a 32 MiB cap: the output is held in memory only, parsed for addresses,
 * types, actions and the state serial, and dropped. It is never logged
 * (suppressExcerpts stays true) and never put in evidence. Output beyond the
 * cap marks the result truncated and the run fails closed instead of parsing a
 * partial document. Every other step, and the timeout, keep the reviewed
 * defaults. Raising 32 MiB later is a reviewed change, not a retry.
 */
export const LARGE_OUTPUT_BYTES = 32 * MIB;
const profileFor = (executable: string, large: boolean): ProcessProfile =>
  large ? { ...PROFILES[executable], maxOutputBytes: LARGE_OUTPUT_BYTES } : PROFILES[executable];

export type TerraformAdapterOptions = {
  /** Approved executable directories. Defaults to the runner's `approvedToolDirs`. Tests point this at a fake. */
  toolDirs?: readonly string[];
};

/** Codes only: engine output can quote state or plan values, so no message carries any. */
const fail = (code: string): never => { throw new Error("TERRAFORM_ADAPTER:" + code); };

/** Identity variables removed, so a step that needs no credentials is given none. */
function withoutIdentities(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^ALZ_(DISCOVERY|STATE)_/.test(key)));
}

/**
 * Fails closed unless the work directory holds exactly the manifest's files,
 * byte for byte, and the lock file is the one the manifest names. Run after
 * init, because init is the step that could rewrite a file.
 */
function assertProjectMatchesManifest(work: string, manifest: ArtifactManifest): void {
  const difference = projectDifference(work, manifest);
  if (difference) fail(difference);
}

/**
 * `init` installs module code into .terraform/modules, which the manifest does
 * not hash (captureProjectFiles skips .terraform). A remote module source (a
 * registry version range, a git ref) can resolve to different code after the
 * review, and that code would run in `plan` with the DISCOVERY identity. So the
 * only module sources accepted are directories inside the project, whose files
 * the manifest does hash.
 */
function assertModulesAreLocal(work: string): void {
  let raw: string;
  try { raw = readFileSync(join(work, ".terraform", "modules", "modules.json"), "utf8"); } catch { return; }
  let modules: unknown;
  try { modules = (JSON.parse(raw) as { Modules?: unknown }).Modules; } catch { return fail("MODULES_UNREADABLE"); }
  if (!Array.isArray(modules)) return fail("MODULES_UNREADABLE");
  const root = resolve(work);
  for (const entry of modules as { Key?: unknown; Source?: unknown; Dir?: unknown }[]) {
    if (entry?.Key === "") continue;
    if (typeof entry?.Source !== "string" || !/^\.{1,2}\//.test(entry.Source) || typeof entry.Dir !== "string") {
      return fail("MODULE_SOURCE_NOT_LOCAL");
    }
    const dir = resolve(work, entry.Dir);
    if (dir !== root && !dir.startsWith(root + sep)) return fail("MODULE_OUTSIDE_PROJECT");
  }
}

function stateSerial(output: string): string {
  let serial: unknown;
  try { serial = (JSON.parse(output) as { serial?: unknown }).serial; } catch { return fail("STATE_NOT_JSON"); }
  if (typeof serial !== "number" || !Number.isSafeInteger(serial) || serial < 0) return fail("STATE_SERIAL_MISSING");
  return String(serial);
}

/** Address, type and operation of each change, reusing the existing normalizers; nothing else is kept. */
function normalizedResources(engine: TerraformEngine, json: string): ResourceChange[] {
  let plan: { format_version?: unknown; errored?: unknown };
  try { plan = JSON.parse(json); } catch { return fail("PLAN_JSON_INVALID"); }
  if (!plan || typeof plan !== "object" || typeof plan.format_version !== "string" || plan.errored === true) {
    return fail("PLAN_JSON_UNUSABLE");
  }
  const changes = engine === "TERRAFORM" ? normalizeTerraformPlan(json) : normalizeOpenTofuPlan(json);
  return createChangeSet(engine, changes.resources).resources;
}

function execute(
  engine: TerraformEngine,
  operation: PreviewOperation,
  request: PreviewRequest,
  context: AdapterContext,
  options: TerraformAdapterOptions,
): PreviewEvidence {
  const executable = EXECUTABLE[engine];
  const label = engine === "TERRAFORM" ? "terraform_plan" : "opentofu_plan";
  if (request.engine !== engine) return fail("WRONG_ENGINE");
  if (request.mode !== "PROJECT" || context.snapshotPath === null) return fail("PROJECT_MODE_REQUIRED");
  const manifest = request.manifest;
  const startedAt = new Date().toISOString();
  const work = join(context.scratchDir, "work");
  const planFile = join(context.scratchDir, PLAN_FILE_NAME);

  /** Every process goes through here: allowlisted argv, one identity (or none), the runner's own limits. */
  const step = (
    args: readonly string[],
    identity: "STATE" | "DISCOVERY" | null,
    large = false,
  ): string => {
    if (!isAllowedArgv(engine, executable, args)) return fail("ARGV_NOT_ALLOWED");
    const result = runBoundedProcess(label, executable, [...args], work, {
      profile: profileFor(executable, large),
      env: identity === null ? withoutIdentities(context.env) : context.env,
      toolDirs: options.toolDirs,
      identity: identity ?? context.identities.providerReads,
      root: context.scratchDir,
    });
    // A credential the runner refused (a newline, an unapproved host) would otherwise mean a run with no identity.
    if (result.refusedEnvironment?.length) return fail("ENVIRONMENT_REFUSED");
    if (result.truncated) return fail("OUTPUT_TRUNCATED");
    if (!result.ok) return fail(result.exitCode === null ? "NOT_RUN" : "EXIT_" + result.exitCode);
    return result.stdout;
  };

  /** The files, the lock file and the module sources, all against the manifest. */
  const assertBound = (): void => {
    assertProjectMatchesManifest(work, manifest);
    assertModulesAreLocal(work);
  };

  try {
    const copyProblem = copyTree(context.snapshotPath, work);
    if (copyProblem) fail(copyProblem);
    // init builds .terraform itself; one that arrived with the snapshot could hold modules or providers nobody reviewed.
    if (existsSync(join(work, ".terraform"))) fail("PRE_EXISTING_TERRAFORM_DIRECTORY");
    assertProjectMatchesManifest(work, manifest);

    // Needs no credentials, so it gets none.
    const versionOutput = step(VERSION_ARGV, null);
    let reported: unknown;
    try { reported = (JSON.parse(versionOutput) as { terraform_version?: unknown }).terraform_version; } catch { return fail("VERSION_UNREADABLE"); }
    const observedVersion = typeof reported === "string" ? reported : fail("VERSION_UNREADABLE");
    if (observedVersion !== request.resolved.engineVersion) fail("ENGINE_VERSION_MISMATCH");

    // Backend initialization and every read of state use the STATE identity.
    step(INIT_ARGV, "STATE");
    assertBound();
    if (request.target.workspace !== "default") step(workspaceSelectArgv(request.target.workspace), "STATE");
    if (step(WORKSPACE_SHOW_ARGV, "STATE").trim() !== request.target.workspace) fail("WORKSPACE_MISMATCH");
    const stateVersion: StateVersionRecord = {
      kind: "TERRAFORM_SERIAL", value: stateSerial(step(STATE_PULL_ARGV, "STATE", true)), observedAt: new Date().toISOString(),
    };

    // The plan refreshes provider reads, so it runs as DISCOVERY. Locking is on: there is no -lock flag.
    assertBound();
    step(operation === "DESTROY_PREVIEW" ? DESTROY_PREVIEW_PLAN_ARGV : PREVIEW_PLAN_ARGV, "DISCOVERY");
    assertProjectMatchesManifest(work, manifest);

    const resources = normalizedResources(engine, step(SHOW_ARGV, null, true));
    // State that moved while the plan ran would be recorded against the wrong version.
    if (stateSerial(step(STATE_PULL_ARGV, "STATE", true)) !== stateVersion.value) fail("STATE_CHANGED");
    return buildEvidence({
      request, operation,
      adapter: { engine, adapterVersion: ADAPTER_VERSION, argvDigest: terraformArgvDigest(engine) },
      observedEngineVersion: observedVersion, resources, stateVersion, startedAt,
      finishedAt: new Date().toISOString(),
    });
  } finally {
    // The plan and the work directory (provider binaries, copied configuration) go before anything returns.
    rmSync(planFile, { force: true });
    removeTree(work);
  }
}

/** Terraform or OpenTofu behind the common adapter contract. */
export function createTerraformAdapter(engine: TerraformEngine, options: TerraformAdapterOptions = {}): EngineAdapter {
  return {
    engine,
    adapterVersion: ADAPTER_VERSION,
    argvDigest: terraformArgvDigest(engine),
    preview: (request, context) => execute(engine, "PREVIEW", request, context, options),
    destroyPreview: (request, context) => execute(engine, "DESTROY_PREVIEW", request, context, options),
  };
}
