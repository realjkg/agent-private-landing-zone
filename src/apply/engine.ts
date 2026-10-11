import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  LARGE_OUTPUT_BYTES, VERSION_ARGV, WORKSPACE_SHOW_ARGV, assertModulesAreLocal, workspaceSelectArgv,
} from "../teardown/driver/adapters/terraform.js";
import { copyTree, projectDifference } from "../teardown/driver/adapters/project-copy.js";
import type { ResolvedTarget } from "../teardown/driver/types.js";
import type { ArtifactManifest } from "../teardown/manifest.js";
import { ANY_IDENTITY_VARIABLE } from "../tools/identity.js";
import { refusedVariables, runBoundedProcess, runStoppableProcess, type StoppableProcessOptions, type StoppableResult } from "../tools/process.js";
import type { ProcessProfile } from "../tools/profiles.js";
import type { ToolResult } from "../tools/types.js";
import { assertBackendBlock, type BackendBlockRule } from "./backend-block.js";
import type { ProviderSpec } from "./provider.js";
import { isRecord } from "./providers/shared.js";
import type { PilotTarget } from "./types.js";

/**
 * The one way the pilot reaches the engine, for sealing and for applying: an
 * allowlisted argument list, one identity (or none), the runner's own limits,
 * and the project checked against the manifest after every process. Codes
 * only: engine output can quote plan or state values.
 */
class EngineStop extends Error {
  constructor(readonly code: string) { super(code); }
}
export const stop = (code: string): never => { throw new EngineStop(code); };

/** The code in a thrown error: ours, or one the preview adapter's shared helpers throw. Anything else is UNEXPECTED. */
export function codeOf(error: unknown): string {
  if (error instanceof EngineStop) return error.code;
  const adapter = error instanceof Error ? /^TERRAFORM_ADAPTER:(.+)$/.exec(error.message) : null;
  return adapter ? adapter[1] : "UNEXPECTED";
}

type StepIdentity = "DISCOVERY" | "STATE" | "STATE_WRITE" | "APPLY" | null;

/** A step that needs no credentials is given none. */
export const withoutIdentities = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !ANY_IDENTITY_VARIABLE.test(key)));

export type EngineSession = {
  work: string;
  /** Runs one allowlisted step and returns its stdout. Any refusal, truncation or non-zero exit stops with a code. */
  step(args: readonly string[], identity: StepIdentity, large?: boolean): string;
  /** A step that can be stopped while it runs. Returns the raw result; the caller classifies it. */
  stoppable(args: readonly string[], identity: StepIdentity, profile: ProcessProfile, control: Pick<StoppableProcessOptions, "stopWhen" | "pollMs" | "graceMs" | "forwardSignals" | "onStop">): Promise<StoppableResult>;
  /** Identity variables the runner would refuse to hand this step, so a step that cannot be undone is never started with a partial identity. */
  refused(identity: StepIdentity, profile: ProcessProfile): string[];
  /** The files, the lock file and the module sources, all against the manifest. */
  assertBound(): void;
};

export type SessionInput = {
  scratchDir: string;
  /** The environment steps draw their identities from. */
  env: NodeJS.ProcessEnv;
  toolDirs?: readonly string[];
  manifest: ArtifactManifest;
  isAllowed: (args: readonly string[]) => boolean;
  profile: ProcessProfile;
};

export function openSession(input: SessionInput): EngineSession {
  const work = join(input.scratchDir, "work");
  const options = (identity: StepIdentity, profile: ProcessProfile) => ({
    profile, env: identity === null ? withoutIdentities(input.env) : input.env, toolDirs: input.toolDirs,
    identity: identity ?? "DISCOVERY", root: input.scratchDir, suppressDetail: true,
  });
  const guard = (args: readonly string[]): void => { if (!input.isAllowed(args)) stop("ARGV_NOT_ALLOWED"); };
  const check = (result: ToolResult): string => {
    // A credential the runner refused (a newline, an unapproved host) would otherwise mean a run with no identity.
    if (result.refusedEnvironment?.length) return stop("ENVIRONMENT_REFUSED");
    if (result.truncated) return stop("OUTPUT_TRUNCATED");
    if (!result.ok) return stop(result.exitCode === null ? "NOT_RUN" : "EXIT_" + result.exitCode);
    return result.stdout;
  };
  return {
    work,
    step(args, identity, large = false) {
      guard(args);
      const profile = large ? { ...input.profile, maxOutputBytes: LARGE_OUTPUT_BYTES } : input.profile;
      return check(runBoundedProcess("terraform_plan", "terraform", [...args], work, options(identity, profile)));
    },
    stoppable(args, identity, profile, control) {
      guard(args);
      return runStoppableProcess("terraform_plan", "terraform", [...args], work, { ...options(identity, profile), ...control });
    },
    refused(identity, profile) {
      return refusedVariables(options(identity, profile));
    },
    assertBound() {
      const difference = projectDifference(work, input.manifest);
      if (difference) stop(difference);
      assertModulesAreLocal(work);
    },
  };
}

/** What a run needs besides the session to reach "the pinned project, initialized, in the target's workspace". */
type WorkspaceInput = {
  snapshotPath: string;
  engineVersion: string;
  target: ResolvedTarget;
  initArgv: readonly string[];
  /** The identity that owns the backend: STATE to read for a preview, STATE_WRITE to write for an apply. */
  stateIdentity: "STATE" | "STATE_WRITE";
  /** The provider's rule for the project's own backend block, judged before init reads it (`ProviderSpec.backendBlock`). */
  backendBlock?: BackendBlockRule;
  /** Runs between the version check and init (the apply writes its backend configuration here). */
  beforeInit?: () => void;
  afterInit?: () => void;
};

/**
 * The one init and workspace sequence: a writable copy of the snapshot that
 * must equal the manifest, the pinned engine version, backend initialization,
 * and the target's workspace. Locking stays on: there is no -lock flag in any
 * argument list. Nothing here changes state.
 */
export function prepareWorkspace(session: EngineSession, input: WorkspaceInput): void {
  const copyProblem = copyTree(input.snapshotPath, session.work);
  if (copyProblem) stop(copyProblem);
  // init builds .terraform itself; one that arrived with the snapshot could hold modules or providers nobody reviewed.
  if (existsSync(join(session.work, ".terraform"))) stop("PRE_EXISTING_TERRAFORM_DIRECTORY");
  session.assertBound();

  let reported: unknown;
  try { reported = (JSON.parse(session.step(VERSION_ARGV, null)) as { terraform_version?: unknown }).terraform_version; } catch (error) {
    if (error instanceof EngineStop) throw error;
    return stop("VERSION_UNREADABLE");
  }
  if (reported !== input.engineVersion) stop("ENGINE_VERSION_MISMATCH");

  if (input.backendBlock) assertBackendBlock(session.work, input.backendBlock);
  input.beforeInit?.();
  try { session.step(input.initArgv, input.stateIdentity); } finally { input.afterInit?.(); }
  session.assertBound();
  if (input.target.workspace !== "default") session.step(workspaceSelectArgv(input.target.workspace), input.stateIdentity);
  if (session.step(WORKSPACE_SHOW_ARGV, input.stateIdentity).trim() !== input.target.workspace) stop("WORKSPACE_MISMATCH");
}

/** The backend binding: the backend init saved must be the contract's, so the project's own backend block cannot aim state somewhere else. */
export function assertBackendInContract(work: string, pinned: PilotTarget, spec: ProviderSpec): void {
  let saved: unknown;
  try {
    const file = join(work, ".terraform", "terraform.tfstate");
    if (!lstatSync(file).isFile() || lstatSync(file).size > 1_048_576) return stop("BACKEND_UNREADABLE");
    saved = JSON.parse(readFileSync(file, "utf8"));
  } catch { return stop("BACKEND_UNREADABLE"); }
  const backend = (saved as { backend?: unknown } | null)?.backend;
  if (!spec.savedBackendMatches(isRecord(backend) ? backend : {}, pinned)) stop("BACKEND_NOT_IN_CONTRACT");
}
