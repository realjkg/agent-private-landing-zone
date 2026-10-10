import { createPrivateDirectory } from "../../tools/private-workdir.js";
import { collapsedIdentityVariables, forbiddenIdentityVariables } from "../../tools/identity.js";
import {
  bindPreview,
  validateManifestForRequest,
  type ManifestRequest,
} from "../manifest.js";
import { captureProjectFiles, createImmutableSnapshot, type ImmutableSnapshot } from "../snapshot.js";
import { evaluateDestroyPreview } from "../gates.js";
import { verifyDeletionUnit } from "../unit.js";
import { registerCleanup, removeTree } from "./cleanup.js";
import { checkAdapterEvidence, finalizeEvidence } from "./evidence.js";
import { engineActivation, type QualificationRecord } from "./qualification.js";
import {
  ADAPTER_IDENTITIES,
  NESTED_REQUEST_KEYS,
  REQUEST_KEYS,
  type AdapterContext,
  type DriverRefusalCode,
  type DriverResult,
  type EngineAdapter,
  type PreviewOperation,
  type PreviewRequest,
} from "./types.js";

/**
 * The human-invoked preview driver (docs/destroy-preview-driver.md).
 *
 * The operator authorizes the preview, the driver enforces the contract, and
 * no preview capability grants authority to change infrastructure. Each step
 * below fails closed and nothing after it runs. The adapter is reached only
 * after every check has passed, and it receives an already-validated,
 * already-snapshotted request.
 */
export type DriverDeps = {
  adapters: readonly EngineAdapter[];
  qualifications: readonly QualificationRecord[];
  /** The environment identity variables are read from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Where private snapshot and scratch directories are created. Defaults to the system temp directory. */
  scratchParent?: string;
  /** Test seam for the snapshot step. Defaults to createImmutableSnapshot. */
  createSnapshot?: typeof createImmutableSnapshot;
};

const refuse = (code: DriverRefusalCode, message: string, fields?: string[]): DriverResult =>
  ({ ok: false, code, message, ...(fields ? { fields } : {}) });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const SAFE_OPERATOR = /^[A-Za-z0-9._@+-]{1,128}$/;
const TARGET_KEYS = ["account", "backend", "workspace"] as const;

/** Step 1: a person at an interactive session named this exact target. */
function checkHumanInvocation(request: PreviewRequest): DriverResult | undefined {
  const invocation = isRecord(request) ? request.invocation as unknown : undefined;
  if (!isRecord(invocation) || typeof invocation.operatorId !== "string" ||
    !SAFE_OPERATOR.test(invocation.operatorId) || invocation.interactiveSession !== true ||
    typeof invocation.confirmedAt !== "string" || Number.isNaN(Date.parse(invocation.confirmedAt))) {
    return refuse("HUMAN_INVOCATION_REQUIRED",
      "A destroy preview is run by a person: the request needs an invocation record with an operator id, " +
      "an interactive session and the time the target was confirmed. An agent cannot start one.");
  }
  const confirmed = invocation.confirmedTarget;
  const target = request.target as unknown;
  if (!isRecord(confirmed) || !isRecord(target) ||
    TARGET_KEYS.some((key) => typeof confirmed[key] !== "string" || confirmed[key] !== target[key])) {
    return refuse("HUMAN_CONFIRMATION_MISMATCH",
      "The target the operator typed is not the exact target of this request (account, backend, workspace or stack).");
  }
  return undefined;
}

/** Step 2: the request carries only known fields, at every level. There is nothing to turn a check off. */
function checkKnownFields(request: PreviewRequest): DriverResult | undefined {
  const unknown = Object.keys(request).filter((key) => !REQUEST_KEYS.includes(key)).map((key) => key);
  for (const [name, allowed] of Object.entries(NESTED_REQUEST_KEYS)) {
    const nested = name === "confirmedTarget" ? (request.invocation as unknown as Record<string, unknown>)?.confirmedTarget
      : (request as unknown as Record<string, unknown>)[name];
    if (isRecord(nested)) {
      unknown.push(...Object.keys(nested).filter((key) => !allowed.includes(key)).map((key) => name + "." + key));
    }
  }
  return unknown.length === 0 ? undefined : refuse("UNKNOWN_REQUEST_FIELD",
    "The request carries fields the driver does not know (" + unknown.sort().join(", ") +
    "). Unknown fields are refused, and no field can relax a check.");
}

const configured = (env: NodeJS.ProcessEnv, prefix: string): boolean =>
  Object.entries(env).some(([key, value]) => key.startsWith(prefix) && typeof value === "string" && value !== "");

/** Step 5: both identities exist, they are different principals, and no mistaken identity is exported. */
function checkIdentities(env: NodeJS.ProcessEnv): DriverResult | undefined {
  const missing = (["DISCOVERY", "STATE"] as const).filter((name) => !configured(env, "ALZ_" + name + "_"));
  if (missing.length > 0) {
    return refuse("IDENTITY_NOT_CONFIGURED",
      "No credentials are configured for the " + missing.join(" and ") + " identity (variables named ALZ_<IDENTITY>_<VARIABLE>). " +
      "Neither identity falls back to the other, to your own credentials or to a deployment identity.");
  }
  const collapsed = collapsedIdentityVariables(env);
  if (collapsed.length > 0) {
    return refuse("IDENTITY_COLLAPSED",
      "The STATE and DISCOVERY identities carry the same secret for " + collapsed.join(", ") +
      ". They must be separate principals with separate credentials.");
  }
  const forbidden = forbiddenIdentityVariables(env);
  if (forbidden.length > 0) {
    return refuse("IDENTITY_FORBIDDEN",
      "Variables for an identity this system never reads are set (" + forbidden.join(", ") +
      "). Remove them; nothing will use them.");
  }
  return undefined;
}

/** What the driver resolved itself (the files) plus what the caller resolved, in the manifest's comparison shape. */
function manifestRequest(request: PreviewRequest, files: ManifestRequest["files"], unitHash: string): ManifestRequest {
  const { resolved } = request;
  return {
    engine: request.engine,
    mode: request.mode,
    target: { ...request.target },
    unitHash,
    engineVersion: resolved.engineVersion,
    providers: resolved.providers,
    lockFileSha256: resolved.lockFileSha256,
    files,
    dependencies: resolved.dependencies,
    inputs: resolved.inputs,
    executionManifestSha256: resolved.executionManifestSha256,
    policyVersion: request.policyVersion,
  };
}

function run(operation: PreviewOperation, request: PreviewRequest, deps: DriverDeps): DriverResult {
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;

  // 1. A person invoked it. 2. Nothing outside the known set is present.
  const human = checkHumanInvocation(request);
  if (human) return human;
  const known = checkKnownFields(request);
  if (known) return known;

  // 3. The engine is qualified for this adapter, argv and engine version.
  const activation = engineActivation(request.engine, deps.qualifications, deps.adapters, request.resolved?.engineVersion);
  if (!activation.enabled) return refuse("ENGINE_NOT_QUALIFIED", activation.reason);
  const adapter = deps.adapters.find((candidate) => candidate.engine === request.engine) as EngineAdapter;

  // 4. Reading the cloud, and running project code, are approvals of their own. Neither is mutation authority.
  if (request.mode === "PROJECT" && request.capabilities?.projectCodeExecution !== true) {
    return refuse("PROJECT_CODE_EXECUTION_REQUIRED",
      "A project-mode preview runs provider and module code with the DISCOVERY identity, so it needs " +
      "capabilities.projectCodeExecution (PROJECT_CODE_EXECUTION), which the operator grants at the command's second prompt. " +
      "That approval never permits changing infrastructure.");
  }
  if (request.capabilities?.cloudRead !== true) {
    return refuse("CLOUD_READ_REQUIRED",
      "A preview reads state and provider resources, so the request needs capabilities.cloudRead. " +
      "That approval never permits changing infrastructure.");
  }

  // 5. Identities.
  const identity = checkIdentities(env);
  if (identity) return identity;

  // 6. The unit, the target it names, and the sealed manifest, all before anything executes.
  if (operation === "PREVIEW" && request.mode !== "PROJECT") {
    return refuse("MODE_NOT_SUPPORTED", "An ordinary preview runs the project; STATE_DERIVED mode is for a destroy preview only.");
  }
  let unit;
  try { unit = verifyDeletionUnit(request.unit); } catch {
    return refuse("UNIT_INVALID", "The deletion unit failed verification; re-record it.");
  }
  const ref = unit.stateRef;
  const unitBackend = ref.engine === "PULUMI" ? ref.backendUrl : "location" in ref ? ref.location : undefined;
  const unitWorkspace = ref.engine === "PULUMI" ? ref.stack : "workspace" in ref ? ref.workspace : undefined;
  if (unit.engine !== request.engine || unitBackend !== request.target.backend || unitWorkspace !== request.target.workspace) {
    return refuse("UNIT_TARGET_MISMATCH",
      "The request does not target the state container the deletion unit recorded (engine, backend, workspace or stack).");
  }
  let files: ManifestRequest["files"] = [];
  if (request.mode === "PROJECT") {
    try { files = captureProjectFiles(request.projectRoot); } catch (error) {
      return refuse("SNAPSHOT_REFUSED", (error as Error).message.replace(/^ARTIFACT_SNAPSHOT_REFUSED:/, "The project cannot be snapshotted: "));
    }
  }
  let validation;
  try {
    validation = validateManifestForRequest(request.manifest, manifestRequest(request, files, unit.unitHash));
  } catch (error) {
    return refuse("MANIFEST_INVALID", (error as Error).message.replace(/^ARTIFACT_MANIFEST_INVALID:/, "The manifest is not valid: "));
  }
  if (!validation.ok) {
    return refuse("REVIEW_REQUIRED", validation.message, [...new Set(validation.mismatches.map((m) => m.field))]);
  }

  // 7..9 run inside one frame so the snapshot and scratch are always removed.
  const scratch = createPrivateDirectory("alz-preview-", deps.scratchParent);
  let snapshot: ImmutableSnapshot | undefined;
  // Also removed by the CLI's signal handlers, which a `finally` block cannot cover.
  const unregister = registerCleanup(() => {
    try { snapshot?.remove(); } finally { removeTree(scratch.path); }
  });
  try {
    if (request.mode === "PROJECT") {
      try {
        snapshot = (deps.createSnapshot ?? createImmutableSnapshot)(request.projectRoot, request.manifest, deps.scratchParent);
      } catch (error) {
        return refuse("SNAPSHOT_REFUSED", (error as Error).message.replace(/^ARTIFACT_SNAPSHOT_REFUSED:/, "The project cannot be snapshotted: "));
      }
      try { snapshot.verify(); } catch {
        return refuse("SNAPSHOT_CHANGED", "The snapshot no longer matches the manifest; a newly reviewed manifest is required.");
      }
    }
    const context: AdapterContext = {
      snapshotPath: snapshot?.path ?? null,
      scratchDir: scratch.path,
      identities: ADAPTER_IDENTITIES,
      env,
    };
    const startedAt = now().toISOString();
    let candidate;
    try {
      candidate = operation === "DESTROY_PREVIEW" ? adapter.destroyPreview(request, context) : adapter.preview(request, context);
    } catch {
      // The adapter's error text can quote engine output, which can quote state. It is not forwarded.
      return refuse("ADAPTER_FAILED", "The " + request.engine + " adapter failed. Its output is withheld because plan and state output can hold secrets.");
    }
    // Project code ran with the DISCOVERY identity. If it reached the snapshot, the label would be wrong.
    if (snapshot) {
      try { snapshot.verify(); } catch {
        return refuse("SNAPSHOT_CHANGED", "The snapshot changed while the preview ran; the result is withheld.");
      }
    }
    try {
      const checked = checkAdapterEvidence(candidate, { request, operation, adapter: {
        engine: adapter.engine, adapterVersion: adapter.adapterVersion, argvDigest: adapter.argvDigest,
      } });
      // 10. The existing gate decides; the driver adds no verdict logic.
      const preview = operation === "DESTROY_PREVIEW" ? evaluateDestroyPreview(unit, checked.changes) : undefined;
      const binding = bindPreview(validation, unit.unitHash, checked.stateVersion);
      const evidence = finalizeEvidence(checked, {
        binding, verdict: preview?.verdict ?? null, startedAt, finishedAt: now().toISOString(),
      });
      return { ok: true, evidence, ...(preview ? { preview } : {}) };
    } catch (error) {
      const message = (error as Error).message;
      return refuse("EVIDENCE_REJECTED", message.startsWith("EVIDENCE_REJECTED:")
        ? "The adapter's evidence was rejected: " + message.slice("EVIDENCE_REJECTED:".length)
        : "The adapter's evidence was rejected.");
    }
  } finally {
    unregister();
    try { snapshot?.remove(); } finally { removeTree(scratch.path); }
  }
}

/** Ordinary preview of the project's plan. Separate from, and never a mode of, a destroy preview. */
export function runPreview(request: PreviewRequest, deps: DriverDeps): DriverResult {
  return run("PREVIEW", request, deps);
}

/** Destroy preview: the plan that `destroy` would run, evaluated against the deletion unit. It destroys nothing. */
export function runDestroyPreview(request: PreviewRequest, deps: DriverDeps): DriverResult {
  return run("DESTROY_PREVIEW", request, deps);
}
