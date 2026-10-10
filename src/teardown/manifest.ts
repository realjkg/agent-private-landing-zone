import { sha256 } from "../build/provenance.js";
import type { IaCEngine } from "../build/types.js";

/**
 * Artifact binding for a governed destroy preview (docs/artifact-binding.md,
 * Decision 6 of docs/teardown-broker-review.md).
 *
 * A preview is bound to a sealed manifest of the inputs that actually run, is
 * validated against the request before anything executes, and fails closed on
 * any difference. There is no override: a mismatch needs a newly reviewed
 * manifest. The current state version is recorded beside the manifest and is
 * never part of it, because live state is not expected to match a hash taken
 * when the infrastructure was built.
 */
export type ManifestEngine = Extract<IaCEngine, "TERRAFORM" | "OPENTOFU" | "PULUMI">;
export const MANIFEST_ENGINES: readonly ManifestEngine[] = ["TERRAFORM", "OPENTOFU", "PULUMI"];

/** PROJECT: the project's own files run. STATE_DERIVED: a Pulumi destroy preview that reads state and runs no project. */
export type InputMode = "PROJECT" | "STATE_DERIVED";

export type ManifestFile = { path: string; sha256: string };
export type ManifestProvider = { source: string; version: string };
export type ManifestDependency = { name: string; version: string; integrity: string };
export type ManifestInput = { name: string; identity: string };

export type ManifestBody = {
  schemaVersion: 1;
  engine: ManifestEngine;
  operation: "DESTROY_PREVIEW";
  mode: InputMode;
  target: { account: string; backend: string; workspace: string };
  unitHash: string;
  engineVersion: string;
  providers: ManifestProvider[];
  /** Terraform and OpenTofu, PROJECT mode: the dependency lock file's hash. */
  lockFileSha256?: string;
  /** PROJECT mode: configuration or program content, one entry per file. */
  files: ManifestFile[];
  /** PROJECT mode: resolved modules and language dependencies, by integrity hash. */
  dependencies: ManifestDependency[];
  /** Identities of variable and configuration inputs (a hash of a non-secret descriptor), never values. */
  inputs: ManifestInput[];
  /** STATE_DERIVED mode: hash of the approved state-derived execution manifest. */
  executionManifestSha256?: string;
  policyVersion: string;
};
export type ArtifactManifest = ManifestBody & { manifestHash: string };

const HASH = /^[a-f0-9]{64}$/;
const SAFE_TEXT = /^[A-Za-z0-9._:/@+=~ -]{1,256}$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)[A-Za-z0-9._@+=~/-]{1,240}$/;
const MAX_FILES = 2000;

/** Fields that would tie the manifest to live state. Recorded separately, never here. */
const STATE_FIELD = /state|serial|lineage|etag|versionid/i;

function invalid(code: string): never {
  throw new Error("ARTIFACT_MANIFEST_INVALID:" + code);
}
function require(ok: unknown, code: string): asserts ok {
  if (!ok) invalid(code);
}

/** Canonical JSON: sorted keys at every level, so equal manifests hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort().filter((key) => record[key] !== undefined)
      .map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

const byKey = <T>(items: readonly T[], key: (item: T) => string): T[] =>
  [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

function noDuplicates(keys: string[], code: string): void {
  require(new Set(keys).size === keys.length, code);
}

function validateBody(body: ManifestBody): ManifestBody {
  require(body.schemaVersion === 1, "SCHEMA_VERSION");
  require((MANIFEST_ENGINES as readonly string[]).includes(body.engine), "ENGINE");
  require(body.operation === "DESTROY_PREVIEW", "OPERATION");
  require(body.mode === "PROJECT" || body.mode === "STATE_DERIVED", "MODE");
  for (const key of ["account", "backend", "workspace"] as const) {
    require(SAFE_TEXT.test(body.target?.[key] ?? ""), "TARGET_" + key.toUpperCase());
  }
  require(HASH.test(body.unitHash), "UNIT_HASH");
  require(SAFE_TEXT.test(body.engineVersion), "ENGINE_VERSION");
  require(SAFE_TEXT.test(body.policyVersion), "POLICY_VERSION");
  for (const provider of body.providers) {
    require(SAFE_TEXT.test(provider.source) && SAFE_TEXT.test(provider.version), "PROVIDER");
  }
  noDuplicates(body.providers.map((p) => p.source), "PROVIDER_DUPLICATE");
  for (const input of body.inputs) {
    require(SAFE_TEXT.test(input.name) && HASH.test(input.identity), "INPUT_IDENTITY");
  }
  noDuplicates(body.inputs.map((i) => i.name), "INPUT_DUPLICATE");
  for (const file of body.files) {
    require(SAFE_PATH.test(file.path) && HASH.test(file.sha256), "FILE");
  }
  noDuplicates(body.files.map((f) => f.path), "FILE_DUPLICATE");
  require(body.files.length <= MAX_FILES, "FILE_COUNT");
  for (const dependency of body.dependencies) {
    require(SAFE_TEXT.test(dependency.name) && SAFE_TEXT.test(dependency.version) &&
      HASH.test(dependency.integrity), "DEPENDENCY");
  }
  noDuplicates(body.dependencies.map((d) => d.name + "@" + d.version), "DEPENDENCY_DUPLICATE");

  if (body.mode === "PROJECT") {
    require(body.files.length > 0, "PROJECT_FILES_REQUIRED");
    require(body.executionManifestSha256 === undefined, "PROJECT_HAS_EXECUTION_MANIFEST");
    if (body.engine !== "PULUMI") {
      require(body.lockFileSha256 !== undefined && HASH.test(body.lockFileSha256), "LOCK_FILE_REQUIRED");
    }
  } else {
    // A state-derived preview runs no project, so a project hash would imply proof it cannot give.
    require(body.engine === "PULUMI", "STATE_DERIVED_ENGINE");
    require(body.files.length === 0 && body.dependencies.length === 0 && body.lockFileSha256 === undefined,
      "STATE_DERIVED_HAS_PROJECT_INPUTS");
    require(body.executionManifestSha256 !== undefined && HASH.test(body.executionManifestSha256),
      "EXECUTION_MANIFEST_REQUIRED");
  }
  const text = canonicalJson(body);
  for (const key of keysOf(body)) require(!STATE_FIELD.test(key), "STATE_FIELD_IN_MANIFEST");
  require(text.length < 1_000_000, "TOO_LARGE");
  return body;
}

function keysOf(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => keysOf(item, found));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      found.push(key);
      keysOf(child, found);
    }
  }
  return found;
}

/** Validates and seals a manifest. Lists are sorted so equal inputs always produce the same hash. */
export function buildManifest(input: Omit<ManifestBody, "schemaVersion" | "operation"> &
  Partial<Pick<ManifestBody, "schemaVersion" | "operation">>): ArtifactManifest {
  const body = validateBody({
    ...input,
    schemaVersion: 1,
    operation: "DESTROY_PREVIEW",
    providers: byKey(input.providers, (p) => p.source),
    files: byKey(input.files, (f) => f.path),
    dependencies: byKey(input.dependencies, (d) => d.name + "@" + d.version),
    inputs: byKey(input.inputs, (i) => i.name),
  });
  return { ...body, manifestHash: sha256(canonicalJson(body)) };
}

/** Re-checks a manifest that arrived from outside: shape, rules and seal. */
export function verifyManifest(candidate: unknown): ArtifactManifest {
  require(candidate && typeof candidate === "object" && !Array.isArray(candidate), "NOT_AN_OBJECT");
  const { manifestHash, ...body } = candidate as ArtifactManifest;
  require(typeof manifestHash === "string" && HASH.test(manifestHash), "SEAL_MISSING");
  const checked = validateBody(body as ManifestBody);
  require(sha256(canonicalJson(checked)) === manifestHash, "SEAL_MISMATCH");
  return { ...checked, manifestHash };
}

// --- Validation against a request ------------------------------------------------

/** What the driver resolved for this request, to be compared with the manifest. */
export type ManifestRequest = {
  engine: ManifestEngine;
  mode: InputMode;
  target: { account: string; backend: string; workspace: string };
  unitHash: string;
  engineVersion: string;
  providers: ManifestProvider[];
  lockFileSha256?: string;
  files: ManifestFile[];
  dependencies: ManifestDependency[];
  inputs: ManifestInput[];
  executionManifestSha256?: string;
  policyVersion: string;
};

export type Mismatch = { field: string; expected: string; actual: string };

export type BindingResult =
  | { ok: true; manifestHash: string; label: "ARTIFACT_VALIDATED_DESTROY_PREVIEW"; proves: string }
  | { ok: false; code: "REVIEW_REQUIRED"; mismatches: Mismatch[]; message: string };

const REQUEST_FIELDS = new Set([
  "engine", "mode", "target", "unitHash", "engineVersion", "providers", "lockFileSha256", "files",
  "dependencies", "inputs", "executionManifestSha256", "policyVersion",
]);

const PROVES: Record<InputMode, string> = {
  PROJECT: "the configuration or program files, resolved dependencies, engine and provider versions, input identities and target that run",
  STATE_DERIVED: "the approved state-derived execution manifest and target; the project is not run, so no project hash is implied",
};

function setOf(items: readonly unknown[]): Set<string> {
  return new Set(items.map((item) => canonicalJson(item)));
}

function compareList(field: string, expected: readonly unknown[], actual: readonly unknown[], out: Mismatch[]): void {
  const want = setOf(expected);
  const have = setOf(actual);
  for (const item of want) {
    if (!have.has(item)) out.push({ field, expected: item, actual: "(absent)" });
  }
  for (const item of have) {
    if (!want.has(item)) out.push({ field, expected: "(absent)", actual: item });
  }
}

/**
 * Compares the approved manifest with what this request resolved. Any
 * difference, including an extra input, blocks. The signature has no override,
 * and a request carrying any field this function does not know (a `force` or
 * `skip` of any spelling) is refused, not ignored.
 */
export function validateManifestForRequest(approved: ArtifactManifest, request: ManifestRequest): BindingResult {
  const unknown = Object.keys(request).filter((key) => !REQUEST_FIELDS.has(key));
  if (unknown.length > 0) invalid("UNKNOWN_REQUEST_FIELD:" + unknown.sort().join(","));
  verifyManifest(approved);

  const mismatches: Mismatch[] = [];
  const same = (field: string, expected: string | undefined, actual: string | undefined) => {
    if ((expected ?? "") !== (actual ?? "")) {
      mismatches.push({ field, expected: expected ?? "(absent)", actual: actual ?? "(absent)" });
    }
  };
  same("engine", approved.engine, request.engine);
  same("mode", approved.mode, request.mode);
  same("target.account", approved.target.account, request.target.account);
  same("target.backend", approved.target.backend, request.target.backend);
  same("target.workspace", approved.target.workspace, request.target.workspace);
  same("unitHash", approved.unitHash, request.unitHash);
  same("engineVersion", approved.engineVersion, request.engineVersion);
  same("policyVersion", approved.policyVersion, request.policyVersion);
  same("lockFileSha256", approved.lockFileSha256, request.lockFileSha256);
  same("executionManifestSha256", approved.executionManifestSha256, request.executionManifestSha256);
  compareList("providers", approved.providers, request.providers, mismatches);
  compareList("files", approved.files, request.files, mismatches);
  compareList("dependencies", approved.dependencies, request.dependencies, mismatches);
  compareList("inputs", approved.inputs, request.inputs, mismatches);

  if (mismatches.length > 0) {
    return {
      ok: false,
      code: "REVIEW_REQUIRED",
      mismatches,
      message: "The inputs differ from the approved manifest (" +
        [...new Set(mismatches.map((m) => m.field))].join(", ") +
        "). A newly reviewed manifest is required; there is no override.",
    };
  }
  return {
    ok: true,
    manifestHash: approved.manifestHash,
    label: "ARTIFACT_VALIDATED_DESTROY_PREVIEW",
    proves: PROVES[approved.mode],
  };
}

// --- State version, recorded separately --------------------------------------------

export type StateVersionKind = "BACKEND_OBJECT_VERSION" | "TERRAFORM_SERIAL" | "PULUMI_CHECKPOINT_VERSION" | "ETAG" | "OTHER";
export type StateVersionRecord = { kind: StateVersionKind; value: string; observedAt: string };

export function recordStateVersion(input: StateVersionRecord): StateVersionRecord {
  require(["BACKEND_OBJECT_VERSION", "TERRAFORM_SERIAL", "PULUMI_CHECKPOINT_VERSION", "ETAG", "OTHER"].includes(input.kind), "STATE_KIND");
  require(SAFE_TEXT.test(input.value), "STATE_VALUE");
  require(!Number.isNaN(Date.parse(input.observedAt)), "STATE_OBSERVED_AT");
  return { kind: input.kind, value: input.value, observedAt: input.observedAt };
}

/** What is stored with a preview: the manifest by hash, and the state version observed at that moment. */
export type PreviewBinding = {
  manifestHash: string;
  unitHash: string;
  stateVersion: StateVersionRecord;
  label: "ARTIFACT_VALIDATED_DESTROY_PREVIEW";
};

export function bindPreview(result: BindingResult, unitHash: string, stateVersion: StateVersionRecord): PreviewBinding {
  require(result.ok, "BINDING_NOT_VALIDATED");
  return { manifestHash: result.manifestHash, unitHash, stateVersion: recordStateVersion(stateVersion), label: result.label };
}

/**
 * An assessment from inventory alone (tags, orphan listings, a plan taken
 * from a different artifact) stays available but is never given the validated
 * label.
 */
export function assessmentLabel(binding: PreviewBinding | undefined): "ARTIFACT_VALIDATED_DESTROY_PREVIEW" | "INVENTORY_ONLY_NOT_ARTIFACT_VALIDATED" {
  return binding?.label === "ARTIFACT_VALIDATED_DESTROY_PREVIEW" && HASH.test(binding.manifestHash)
    ? "ARTIFACT_VALIDATED_DESTROY_PREVIEW"
    : "INVENTORY_ONLY_NOT_ARTIFACT_VALIDATED";
}
