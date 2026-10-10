import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { sha256 } from "../../../build/provenance.js";
import { normalizePulumiPreview } from "../../../iac/pulumi-preview.js";
import { runBoundedProcess } from "../../../tools/process.js";
import { PROFILES, type ProcessProfile } from "../../../tools/profiles.js";
import type { ExecutionIdentity } from "../../../tools/identity.js";
import { recordStateVersion, type StateVersionRecord } from "../../manifest.js";
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
 * The Pulumi (TypeScript) destroy-preview adapter (docs/destroy-preview-driver.md,
 * "Pulumi adapter").
 *
 * It runs the pinned argument lists below and nothing else. A destroy preview
 * is `destroy --preview-only`: the CLI is asked for a plan and never for a
 * destroy, so nothing depends on a prompt or a cancellation. `--run-program`
 * decides whether the TypeScript program runs: PROJECT mode runs it (and needs
 * PROJECT_CODE_EXECUTION); STATE_DERIVED mode reads state and runs no program.
 *
 * In PROJECT mode the program runs in a writable copy of the snapshot, never in
 * the snapshot (which the program's own account could rewrite), and the copy is
 * compared with the manifest before and after the program. Every
 * STATE-identity step runs in a separate empty directory, so project files the
 * program could change are never in the working directory of a process that
 * holds the state credential.
 *
 * NONE OF THESE FLAGS COULD BE CHECKED: there is no Pulumi CLI in the build
 * sandbox. The adapter therefore ships DISABLED. No qualification record is
 * bundled, and the driver refuses the engine until one is supplied after the
 * flags in PULUMI_UNVERIFIED are confirmed on the pinned version.
 */
export const PULUMI_ADAPTER_VERSION = "1.0.0";

/** Stands for the stack name in a pinned argument list; replaced by the validated target stack. */
export const STACK_SLOT = "<stack>";

/** Every argument list the adapter may run, in one place. The stack is the only value filled in. */
export const PULUMI_ARGV = {
  VERSION: ["pulumi", "version"],
  STATE_EXPORT: ["pulumi", "stack", "export", "--stack", STACK_SLOT, "--non-interactive"],
  PREVIEW_PROJECT: ["pulumi", "preview", "--non-interactive", "--stack", STACK_SLOT, "--json"],
  DESTROY_PREVIEW_PROJECT: [
    "pulumi", "destroy", "--preview-only", "--non-interactive", "--stack", STACK_SLOT, "--json", "--run-program",
  ],
  DESTROY_PREVIEW_STATE_DERIVED: [
    "pulumi", "destroy", "--preview-only", "--non-interactive", "--stack", STACK_SLOT, "--json", "--run-program=false",
  ],
} as const satisfies Record<string, readonly string[]>;

export const PULUMI_ARGV_DIGEST: string = argvDigest(Object.values(PULUMI_ARGV));

/** What qualification has to confirm on the pinned Pulumi version before a record is supplied. */
export const PULUMI_UNVERIFIED: readonly string[] = [
  "destroy --preview-only: exists, takes the lock the way a destroy does, and changes nothing",
  "destroy --run-program (project run) and --run-program=false (no program): spelling, and that false really runs no program",
  "destroy --preview-only --json: prints one JSON document with a `steps` list shaped like `preview --json`",
  "destroy --preview-only --non-interactive: needs no confirmation flag and exits 0 on a successful preview",
  "preview --json and --stack: spelling and output shape",
  "stack export --stack: prints `{ version, deployment }` to stdout with secrets left encrypted",
  "version: prints `v<major>.<minor>.<patch>`",
  "the state steps work from the scratch directory with the stack name recorded in the deletion unit (no project file)",
  "the state steps work from an empty directory with a fully qualified stack name while the program runs in a separate work copy",
  "a Pulumi.yaml in a parent directory of the scratch directory is not picked up by a run that has no project",
];

/**
 * Plan JSON for a large stack outgrows the runner's 1 MiB default, so this
 * adapter has its own reviewed output cap. Everything else is the shared
 * `pulumi` profile: the same injectable names and the same approved hosts.
 */
export const PULUMI_PREVIEW_PROFILE: ProcessProfile = { ...PROFILES.pulumi, maxOutputBytes: 8 * 1024 * 1024 };

// One to three segments (stack, project/stack or org/project/stack); no segment starts with a dash or is a dot path.
const SEGMENT = "(?!-)(?!\\.{1,2}(?:/|$))[A-Za-z0-9._-]{1,100}";
const STACK_NAME = new RegExp("^" + SEGMENT + "(?:/" + SEGMENT + "){0,2}$");
const ENGINE_VERSION = /^v?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/;

function bind(template: readonly string[], stack: string): string[] {
  return template.map((arg) => (arg === STACK_SLOT ? stack : arg));
}

/**
 * Exact match against the pinned lists. The stack slot accepts only a valid
 * stack name; every other argument must be equal. Anything else (`up`, a bare
 * `destroy`, `refresh`, `cancel`, `stack rm`, `state` edits) is not a match.
 */
export function isAllowedPulumiArgv(argv: readonly string[]): boolean {
  return Object.values(PULUMI_ARGV).some((template) =>
    template.length === argv.length &&
    template.every((arg, index) => (arg === STACK_SLOT ? STACK_NAME.test(argv[index]) : arg === argv[index])));
}

export type PulumiAdapterOptions = {
  /** Approved executable directories. Defaults to the runner's (`ALZ_TOOL_DIRS` plus the standard ones). */
  toolDirs?: readonly string[];
};

/** Thrown text never carries engine output: plan and state output can hold secrets. */
function fail(what: string): never {
  throw new Error("PULUMI_ADAPTER_FAILED: " + what);
}

export function createPulumiAdapter(options: PulumiAdapterOptions = {}): EngineAdapter {
  const descriptor = { engine: "PULUMI" as const, adapterVersion: PULUMI_ADAPTER_VERSION, argvDigest: PULUMI_ARGV_DIGEST };

  /** One pinned run. The identity is the caller's choice between the two the driver passed in. */
  function step(
    template: readonly string[],
    stack: string,
    identity: ExecutionIdentity,
    cwd: string,
    context: AdapterContext,
  ): string {
    const argv = bind(template, stack);
    if (!isAllowedPulumiArgv(argv)) fail("argument list is not one of the pinned lists");
    // Diagnostics label only: the broker's ToolName has no entry for these, and this driver is not a broker tool.
    const tool = template === PULUMI_ARGV.VERSION ? "pulumi_version" : "pulumi_preview";
    const result = runBoundedProcess(tool, argv[0], argv.slice(1), cwd, {
      profile: PULUMI_PREVIEW_PROFILE, env: context.env, toolDirs: options.toolDirs, identity, root: cwd,
    });
    if (result.blocked) fail("the runner refused the process");
    if (result.refusedEnvironment?.includes("ALZ_" + identity + "_PULUMI_BACKEND_URL")) {
      fail("the " + identity + " backend URL was refused by the runner (unapproved host)");
    }
    if (result.truncated) fail("output exceeded the cap");
    if (!result.ok) fail(argv.slice(1, 3).join(" ") + " exited " + String(result.exitCode));
    return result.stdout;
  }

  /** The backend the identity points at must be the exact backend the person named. */
  function requireBackend(context: AdapterContext, identity: ExecutionIdentity, backend: string): void {
    if (context.env["ALZ_" + identity + "_PULUMI_BACKEND_URL"] !== backend) {
      fail("the " + identity + " identity does not name the requested backend (ALZ_" + identity + "_PULUMI_BACKEND_URL)");
    }
  }

  /** `<checkpoint version>:<sha256 of the export>`. The export itself is hashed here and dropped. */
  function readStateVersion(stdout: string): string {
    let parsed: unknown;
    try { parsed = JSON.parse(stdout); } catch { return fail("stack export is not JSON"); }
    const doc = parsed as { version?: unknown; deployment?: unknown } | null;
    if (!doc || typeof doc !== "object" || !Number.isInteger(doc.version) || typeof doc.deployment !== "object") {
      return fail("stack export has an unexpected shape");
    }
    return String(doc.version) + ":" + sha256(stdout);
  }

  function resources(stdout: string) {
    let steps: unknown;
    try { steps = (JSON.parse(stdout) as { steps?: unknown } | null)?.steps; } catch { return fail("preview output is not JSON"); }
    // A document without a step list is an output shape this adapter was not qualified against, not "nothing to do".
    if (!Array.isArray(steps)) return fail("preview output has no step list");
    return normalizePulumiPreview(stdout).resources;
  }

  function run(operation: PreviewOperation, request: PreviewRequest, context: AdapterContext): PreviewEvidence {
    if (request.engine !== "PULUMI") fail("not a Pulumi request");
    const stack = request.target.workspace;
    if (!STACK_NAME.test(stack)) fail("the stack name is not valid");
    const project = request.mode === "PROJECT";
    if (project && (context.snapshotPath === null || request.capabilities.projectCodeExecution !== true)) {
      fail("a project-mode run needs a snapshot and PROJECT_CODE_EXECUTION");
    }
    if (!project && (request.mode !== "STATE_DERIVED" || context.snapshotPath !== null)) {
      fail("a state-derived run takes no snapshot");
    }
    if (operation === "PREVIEW" && !project) fail("an ordinary preview runs the program");

    // The process that runs the program holds provider-read credentials (DISCOVERY) and never the state
    // identity. A state-derived destroy preview runs no program and refreshes nothing, so it needs state reads only.
    const stateReads = context.identities.stateReads;
    const previewIdentity = project ? context.identities.providerReads : stateReads;
    requireBackend(context, stateReads, request.target.backend);
    requireBackend(context, previewIdentity, request.target.backend);

    // The STATE identity's processes never run where project code ran or could write.
    const stateDir = join(context.scratchDir, "state-steps");
    const workDir = join(context.scratchDir, "work");
    mkdirSync(stateDir, { mode: 0o700 });
    const stateStep = (template: readonly string[]): string => {
      const allowed = project ? ["state-steps", "work"] : ["state-steps"];
      if (readdirSync(stateDir).length > 0 || readdirSync(context.scratchDir).some((name) => !allowed.includes(name))) {
        fail("the working directory of the state steps is not empty");
      }
      return step(template, stack, stateReads, stateDir, context);
    };
    const bound = (): void => {
      const difference = projectDifference(workDir, request.manifest);
      if (difference) fail("the project no longer matches the manifest (" + difference.split(":")[0] + ")");
    };
    const template = operation === "PREVIEW" ? PULUMI_ARGV.PREVIEW_PROJECT
      : project ? PULUMI_ARGV.DESTROY_PREVIEW_PROJECT : PULUMI_ARGV.DESTROY_PREVIEW_STATE_DERIVED;

    const startedAt = new Date().toISOString();
    try {
      const version = stateStep(PULUMI_ARGV.VERSION).trim().match(ENGINE_VERSION);
      if (!version) fail("the engine version is not recognizable");
      // Qualification binds a record to one engine version: no export, preview or program runs on any other.
      if (version![1] !== request.resolved.engineVersion) fail("the engine version is not the qualified version");
      const before = readStateVersion(stateStep(PULUMI_ARGV.STATE_EXPORT));
      if (project) {
        const problem = copyTree(context.snapshotPath as string, workDir);
        if (problem) fail("the snapshot cannot be copied (" + problem + ")");
        bound();
      }
      const found = resources(step(template, stack, previewIdentity, project ? workDir : stateDir, context));
      if (project) bound();
      // State that moved while the preview ran would be recorded against the wrong version.
      if (readStateVersion(stateStep(PULUMI_ARGV.STATE_EXPORT)) !== before) {
        fail("the state changed while the preview ran");
      }
      const stateVersion: StateVersionRecord = recordStateVersion({
        kind: "PULUMI_CHECKPOINT_VERSION", value: before, observedAt: startedAt,
      });
      return buildEvidence({
        request, operation, adapter: descriptor, observedEngineVersion: version![1],
        resources: found, stateVersion, startedAt, finishedAt: new Date().toISOString(),
      });
    } finally {
      // Whatever the program wrote, including read-only directories, goes before anything returns.
      removeTree(workDir);
      removeTree(stateDir);
    }
  }

  return {
    ...descriptor,
    preview: (request, context) => run("PREVIEW", request, context),
    destroyPreview: (request, context) => run("DESTROY_PREVIEW", request, context),
  };
}

/** The adapter with the runner's default tool directories. Disabled until a qualification record is supplied. */
export const pulumiAdapter: EngineAdapter = createPulumiAdapter();
