import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadToolPins } from "../deps/pins.js";
import { buildManifest, canonicalJson, validateManifestForRequest, verifyManifest, type ArtifactManifest, type ManifestDependency, type ManifestInput } from "../teardown/manifest.js";
import { engineActivation } from "../teardown/driver/qualification.js";
import type { EngineAdapter } from "../teardown/driver/types.js";
import { captureProjectFiles } from "../teardown/snapshot.js";
import { approvedToolDirs } from "../tools/child-env.js";
import { sha256 } from "../util/sha256.js";
import { ENVIRONMENTS } from "./constants.js";
import { isKillSwitchActive, loadPilotContract, loadQualificationRecords, pilotContractSha256, repoPaths, targetForEnvironment } from "./contract.js";
import { acceptsManifest, engineOf } from "./engine-spec.js";
import { BICEP_ENTRY } from "./engines/bicep.js";
import { localPluginPathIn } from "./terraform-constructs.js";
import { LockFileError, lockedProviders, unofficialProviderHash, unreviewedProviderVersion, unreviewedVersionMessage } from "./lockfile.js";
import { checkModules, TerraformConfigError, variableSources } from "./terraform-inputs.js";
import { specOf } from "./provider.js";
import { pilotUnitOf, type PilotUnit } from "./unit.js";
import type { ApplyEnvironment, EngineId, PilotContract, ProviderId } from "./types.js";

/**
 * `./alz apply prepare`: builds the request and the project fingerprint (manifest) that `qualify`, `seal` and
 * `apply` read, so nobody writes them by hand. Every value comes from the reviewed contract, the project folder or an
 * existing qualification record. A value with no source stops preparation with the exact owner or operator step.
 *
 * Preparing never enables ACT, assumes a role, starts a process, seals, approves, applies or creates a change set.
 * Its files are local preparation artifacts, not qualification evidence.
 */

export const PREPARATION_LABEL = "LOCAL_PREPARATION" as const;
/** The same file name the engines' project check uses (src/teardown/driver/adapters/project-copy.ts). */
export const TERRAFORM_LOCK_FILE = ".terraform.lock.hcl";
const AWS_CLI_VERSION = /^\d+\.\d+\.\d+$/;

/** The secondary path for each provider: what an owner could choose instead, and what is not yet supported. */
const PATHS: Readonly<Record<ProviderId, { primary: EngineId; secondary: EngineId | null; secondaryGap: string }>> = {
  AWS: { primary: "TERRAFORM", secondary: "CDK", secondaryGap: "" },
  AZURE: { primary: "TERRAFORM", secondary: "BICEP", secondaryGap: "" },
};

export type PrepareCode =
  | "CONTRACT_DISABLED" | "KILL_SWITCH_ACTIVE" | "POLICY_VERSION_MISSING" | "ENVIRONMENT_INVALID" | "TARGET_NOT_IN_CONTRACT"
  | "PROJECT_INVALID" | "PROJECT_ENGINE_MISMATCH" | "PROJECT_NOT_CLEAN" | "TERRAFORM_LOCAL_PLUGIN_DIR_REFUSED" | "PROJECT_SNAPSHOT_REFUSED"
  | "LOCK_FILE_MISSING" | "LOCK_FILE_UNREADABLE" | "PROVIDER_VERSION_NOT_REVIEWED" | "PROVIDER_HASH_NOT_OFFICIAL" | "PROVIDER_NOT_ADMITTED" | "ENGINE_VERSION_REQUIRED" | "TOOL_UNAVAILABLE" | "MANIFEST_INVALID"
  | "INPUT_UNSET" | "MODULE_REMOTE" | "MODULE_OUTSIDE_PROJECT" | "TERRAFORM_CONFIG_UNREADABLE";

/** Who has to act to clear a refusal: the owner, the operator at this screen, or a missing local tool. */
export type PrepareBlocker = "OWNER" | "OPERATOR" | "TOOL";

export type PrepareInput = {
  environment: string;
  projectRoot: string;
  /** CDK only, and only before the engine is qualified: the installed AWS CLI version (`aws --version`). */
  awsCliVersion?: string;
};

export type PrepareDeps = {
  contractPath?: string;
  qualificationDir?: string;
  toolDirs?: readonly string[];
  pinsPath?: string;
  /** Where ALZ_DISCOVERY_TF_VAR_* are looked for (names only, never values). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
};

export type SealRequestFile = {
  environment: ApplyEnvironment;
  target: { account: string; backend: string; workspace: string };
  projectRoot: string;
  policyVersion: string;
  resolved: {
    engineVersion: string;
    providers: { source: string; version: string }[];
    lockFileSha256?: string;
    dependencies: ManifestDependency[];
    inputs: ManifestInput[];
  };
};

/** Where one input's value comes from, for the review: a file in the project, a named environment variable, or a default. Never the value. */
export type PreparedInput = { name: string; source: "TFVARS" | "ENVIRONMENT" | "DEFAULT"; from: string };

export type NextStep =
  | { step: "qualify"; reason: string }
  | { step: "seal"; reason: string }
  | { step: "blocked"; blocker: PrepareBlocker; reason: string };

export type PreparationSummary = {
  label: typeof PREPARATION_LABEL;
  provider: ProviderId;
  engine: EngineId;
  path: "PRIMARY" | "SECONDARY";
  environment: ApplyEnvironment;
  account: string;
  region?: string;
  backend: string;
  workspace: string;
  projectRoot: string;
  fileCount: number;
  providers: { source: string; version: string }[];
  engineVersion: string;
  engineVersionSource: "QUALIFICATION_RECORD" | "TESTED_PIN" | "OPERATOR";
  inputs: PreparedInput[];
  policyVersion: string;
  unitHash: string;
  manifestHash: string;
  contractSha256: string;
  /** The deletion unit this environment's state container is (src/apply/unit.ts) and the tags the operator's provider configuration must stamp on every created resource; `seal` verifies them in the plan. */
  unit: PilotUnit;
};

export type Prepared = {
  ok: true;
  summary: PreparationSummary;
  request: SealRequestFile;
  manifest: ArtifactManifest;
  /** Known limits of this preparation, shown in the review so nothing reads as more complete than it is. */
  gaps: string[];
  next: NextStep;
};

export type PrepareRefusal = { ok: false; code: PrepareCode; blocker: PrepareBlocker; message: string; alternative?: string };

const refuse = (code: PrepareCode, blocker: PrepareBlocker, message: string, alternative?: string): PrepareRefusal =>
  ({ ok: false, code, blocker, message, ...(alternative ? { alternative } : {}) });

function pathOf(provider: ProviderId, engine: EngineId): "PRIMARY" | "SECONDARY" {
  return PATHS[provider].primary === engine ? "PRIMARY" : "SECONDARY";
}

/** What the operator can do when this engine's tool is missing. Only ever about a missing tool, never about authority. */
function alternativeFor(provider: ProviderId, engine: EngineId): string {
  const paths = PATHS[provider];
  const other = engine === paths.primary ? paths.secondary : paths.primary;
  if (!other) return paths.secondaryGap + " Install the missing tool with ./alz deps.";
  return "Install the missing tool with ./alz deps, or ask the owner to commit a contract for " + other + ". " +
    "A different engine needs its own reviewed contract, its own preview and its own approvals.";
}

function toolPresent(executable: string, dirs: readonly string[]): boolean {
  const names = process.platform === "win32" ? [executable + ".exe", executable] : [executable];
  return dirs.some((dir) => names.some((name) => {
    try { return statSync(join(dir, name)).isFile(); } catch { return false; }
  }));
}

/** The engine-specific shape a project folder must have, checked before anything is hashed. */
function checkProjectShape(engine: EngineId, root: string): PrepareRefusal | undefined {
  let names: string[];
  try {
    if (!lstatSync(root).isDirectory()) return refuse("PROJECT_INVALID", "OPERATOR", "The project location is not a folder.");
    names = readdirSync(root);
  } catch {
    return refuse("PROJECT_INVALID", "OPERATOR", "The project folder does not exist or cannot be read.");
  }
  const hasTf = names.some((name) => name.endsWith(".tf"));
  const hasAssembly = names.includes("manifest.json") && names.some((name) => name.endsWith(".template.json"));
  if (engine === "TERRAFORM") {
    if (!hasTf) {
      return refuse("PROJECT_ENGINE_MISMATCH", "OPERATOR", hasAssembly
        ? "This folder is a CDK cloud assembly, but the contract's engine is Terraform. Choose the Terraform project folder."
        : "This folder has no Terraform (.tf) files. Choose the folder that holds the Terraform project.");
    }
    if (names.includes(".terraform")) {
      return refuse("PROJECT_NOT_CLEAN", "OPERATOR", "The project has a .terraform folder from an earlier init. Remove it; preparation and sealing run their own init.");
    }
    // Providers install only from the official registry (review of #327, round 6): no project-shipped plugin directory or CLI configuration.
    let local: string | undefined;
    try { local = localPluginPathIn(root); } catch { return refuse("PROJECT_INVALID", "OPERATOR", "The project folder cannot be read."); }
    if (local) {
      return refuse("TERRAFORM_LOCAL_PLUGIN_DIR_REFUSED", "OPERATOR", "The project contains " + local + ", a local provider directory or Terraform CLI configuration. Providers install only from the official registry; remove it.");
    }
    if (!names.includes(TERRAFORM_LOCK_FILE)) {
      return refuse("LOCK_FILE_MISSING", "OPERATOR", "The project has no " + TERRAFORM_LOCK_FILE + ". Run terraform init once, review the lock file, and keep it with the project.");
    }
    return undefined;
  }
  if (engine === "BICEP") {
    // The engine compiles exactly main.bicep with the pinned bicep and no module restore; nothing else is an entry point.
    return names.includes(BICEP_ENTRY) ? undefined
      : refuse("PROJECT_ENGINE_MISMATCH", "OPERATOR", "This folder has no " + BICEP_ENTRY + ". Choose the folder that holds the Bicep project's " + BICEP_ENTRY + ".");
  }
  if (!hasAssembly) {
    return refuse("PROJECT_ENGINE_MISMATCH", "OPERATOR", hasTf
      ? "This folder is a Terraform project, but the contract's engine is CDK. Choose the synthesized cdk.out folder."
      : "This folder is not a synthesized CDK cloud assembly (manifest.json and a .template.json). Run cdk synth and choose cdk.out.");
  }
  return undefined;
}

/**
 * The preparation unit. The manifest needs a 64-hex unit hash; the apply path never compares it, so it is derived here
 * from what is being prepared and labeled, never invented or asked for (owner decision, 2026-10-25).
 */
export function preparationUnitHash(input: { engine: EngineId; environment: ApplyEnvironment; target: SealRequestFile["target"]; files: ArtifactManifest["files"] }): string {
  return sha256(canonicalJson({ purpose: "pilot-preparation-unit", ...input }));
}

/** Prepares the request and manifest for one environment. Pure apart from reading the contract, records and project. */
export async function prepareApply(input: PrepareInput, deps: PrepareDeps = {}): Promise<Prepared | PrepareRefusal> {
  const loaded = loadPilotContract(deps.contractPath ?? repoPaths().contract);
  if ("reason" in loaded) {
    return refuse("CONTRACT_DISABLED", "OWNER", "There is no enabled pilot contract that authorizes ACT (" + loaded.reason + "). The owner reviews the contract and commits its authorize entry first.");
  }
  const contract: PilotContract = loaded;
  if (isKillSwitchActive(contract)) {
    return refuse("KILL_SWITCH_ACTIVE", "OWNER", "The emergency stop is on, so nothing is prepared. The owner clears it when it is safe to continue.");
  }
  if (!contract.policyVersion) {
    return refuse("POLICY_VERSION_MISSING", "OWNER", "The reviewed contract has no policyVersion. The owner adds the reviewed policy version to the contract in a reviewed commit.");
  }
  if (!(ENVIRONMENTS as readonly string[]).includes(input.environment)) {
    return refuse("ENVIRONMENT_INVALID", "OPERATOR", "Choose DEV, QA or PROD.");
  }
  const environment = input.environment as ApplyEnvironment;
  const spec = specOf(contract);
  const engine = engineOf(contract);
  const pinned = Object.hasOwn(contract.targets, environment) ? contract.targets[environment] : undefined;
  if (!pinned) return refuse("TARGET_NOT_IN_CONTRACT", "OWNER", "The contract has no " + environment + " target. The owner adds it to the reviewed contract.");
  const target = { account: spec.account(pinned), backend: pinned.backend, workspace: pinned.workspace };
  const confirmed = targetForEnvironment(contract, environment, target);
  if (!confirmed.ok) return refuse("TARGET_NOT_IN_CONTRACT", "OWNER", confirmed.message);

  const dirs = deps.toolDirs ?? approvedToolDirs();
  const missingTool = engine.executables.find((name) => !toolPresent(name, dirs));
  if (missingTool) {
    return refuse("TOOL_UNAVAILABLE", "TOOL", "The " + missingTool + " program is not in the approved tool folders, so this path cannot run here.",
      alternativeFor(spec.id, engine.id));
  }

  const projectRoot = resolve(input.projectRoot);
  const shape = checkProjectShape(engine.id, projectRoot);
  if (shape) return shape;
  let files: ArtifactManifest["files"];
  try {
    files = captureProjectFiles(projectRoot);
  } catch (error) {
    const detail = error instanceof Error ? error.message.replace(/^[A-Z_]+:\s*/, "") : "the project could not be read";
    return refuse("PROJECT_SNAPSHOT_REFUSED", "OPERATOR", "The project cannot be fingerprinted: " + detail);
  }

  let providers: SealRequestFile["resolved"]["providers"] = [];
  let lockFileSha256: string | undefined;
  if (engine.id === "TERRAFORM") {
    const lock = readFileSync(join(projectRoot, TERRAFORM_LOCK_FILE));
    lockFileSha256 = sha256(lock);
    try {
      providers = lockedProviders(lock.toString("utf8"));
    } catch (error) {
      return refuse("LOCK_FILE_UNREADABLE", "OPERATOR", error instanceof LockFileError ? error.message : "The lock file cannot be read.");
    }
    // The aws and azurerm versions are the ones the denied-type lists were reviewed against (review of #327, round 4).
    // Every locked source is one this cloud path may select (review of #327, round 5): the engine judges what init selects again.
    const foreign = providers.find((provider) => !spec.selectableProviders.includes(provider.source));
    if (foreign) {
      return refuse("PROVIDER_NOT_ADMITTED", "OPERATOR", "The lock file pins " + foreign.source + ", which this pilot does not admit for " + spec.id +
        ". Only these provider sources are allowed: " + spec.selectableProviders.join(", ") + ".");
    }
    const unreviewed = unreviewedProviderVersion(providers);
    if (unreviewed) return refuse("PROVIDER_VERSION_NOT_REVIEWED", "OPERATOR", unreviewedVersionMessage(unreviewed));
    // The reviewed version's package hashes are HashiCorp's own (review of #327, round 6).
    let unofficial: { source: string; version: string } | undefined;
    try { unofficial = unofficialProviderHash(lock.toString("utf8")); } catch (error) {
      return refuse("LOCK_FILE_UNREADABLE", "OPERATOR", error instanceof LockFileError ? error.message : "The lock file cannot be read.");
    }
    if (unofficial) {
      return refuse("PROVIDER_HASH_NOT_OFFICIAL", "OPERATOR", "The lock file's hashes for " + unofficial.source + " " + unofficial.version +
        " are missing or are not HashiCorp's published package hashes. Rewrite the lock with terraform init against the official registry.");
    }
  }

  // Inputs: each one's identity is a hash of where its value comes from (a fingerprinted file, a named environment variable
  // or a default), never the value. An input with no value is refused here, before a preview would fail on it.
  const derived = deriveInputs(engine.id, projectRoot, files, deps.env ?? process.env);
  if ("refusal" in derived) return derived.refusal;

  // The engine version: a matching qualification record first; before one exists, the tested pin (Terraform's binary pin,
  // or the AWS CLI's check-only pin for CDK). qualify still checks the real binary. A version the operator passes is
  // accepted only when it is the pin: there is nothing to type any more, and a different version is not the tested one.
  const adapter = engine.previewAdapter() as unknown as EngineAdapter;
  const records = (await loadQualificationRecords(spec, deps.qualificationDir ?? repoPaths().qualifications))
    .filter((record) => record.engine === engine.id && record.adapterVersion === adapter.adapterVersion && record.argvDigest === adapter.argvDigest)
    .sort((a, b) => b.qualifiedAt.localeCompare(a.qualifiedAt));
  let engineVersion: string;
  let engineVersionSource: PreparationSummary["engineVersionSource"];
  if (records.length > 0) {
    engineVersion = records[0].engineVersion;
    engineVersionSource = "QUALIFICATION_RECORD";
  } else {
    const pins = loadToolPins(deps.pinsPath);
    // Bicep's engine version is the az CLI's (src/apply/engines/bicep.ts checks it, and the pinned bicep, before anything runs).
    engineVersion = engine.id === "TERRAFORM" ? pins.tools.terraform.version : engine.id === "BICEP" ? pins.azureCli.version : pins.awsCli.version;
    engineVersionSource = "TESTED_PIN";
    if (engine.id === "CDK" && input.awsCliVersion !== undefined && input.awsCliVersion !== engineVersion) {
      return refuse("ENGINE_VERSION_REQUIRED", "OPERATOR", AWS_CLI_VERSION.test(input.awsCliVersion)
        ? "The CDK path is tested with AWS CLI " + engineVersion + ", and that is the version preparation records; " + input.awsCliVersion + " is not it. Install the tested version (./alz deps shows the step), then prepare again without naming a version."
        : "That is not an AWS CLI version. The tested version is " + engineVersion + "; prepare again without naming one.");
    }
  }

  const unitHash = preparationUnitHash({ engine: engine.id, environment, target, files });
  let manifest: ArtifactManifest;
  try {
    manifest = verifyManifest(buildManifest({
      engine: engine.id, mode: engine.manifestMode, target, unitHash, engineVersion, providers,
      ...(lockFileSha256 ? { lockFileSha256 } : {}), files, dependencies: [], inputs: derived.inputs, policyVersion: contract.policyVersion,
    }));
  } catch (error) {
    return refuse("MANIFEST_INVALID", "OPERATOR", "The project fingerprint could not be built: " + (error instanceof Error ? error.message : "invalid input"));
  }
  if (!acceptsManifest(engine, manifest)) return refuse("MANIFEST_INVALID", "OPERATOR", "The project fingerprint does not match the contract's engine.");
  const request: SealRequestFile = {
    environment, target, projectRoot, policyVersion: contract.policyVersion,
    resolved: { engineVersion, providers, ...(lockFileSha256 ? { lockFileSha256 } : {}), dependencies: [], inputs: derived.inputs },
  };
  // The same binding seal performs, run now so a mismatch is found here and not later.
  const binding = validateManifestForRequest(manifest, {
    engine: engine.id, mode: engine.manifestMode, target, unitHash: manifest.unitHash, engineVersion, providers,
    lockFileSha256, files: captureProjectFiles(projectRoot), dependencies: [], inputs: derived.inputs, policyVersion: contract.policyVersion,
  });
  if (!binding.ok) return refuse("MANIFEST_INVALID", "OPERATOR", "The project changed while it was being prepared. Prepare it again.");

  const activation = engineActivation(engine.id, records, [adapter], engineVersion);
  let next: NextStep;
  if (activation.enabled) next = { step: "seal", reason: "The " + engine.id + " path is qualified, so the next step is to seal a plan for review." };
  else if (environment === "DEV") next = { step: "qualify", reason: "The " + engine.id + " path is not qualified yet. Qualify it in DEV, with the owner watching the cloud logs, before sealing." };
  else next = { step: "blocked", blocker: "OWNER", reason: "The " + engine.id + " path must be qualified in DEV before " + environment + " can be sealed." };

  const region = typeof (pinned as unknown as { region?: unknown }).region === "string" ? (pinned as unknown as { region: string }).region : undefined;
  return {
    ok: true,
    summary: {
      label: PREPARATION_LABEL, provider: spec.id, engine: engine.id, path: pathOf(spec.id, engine.id), environment,
      account: target.account, ...(region ? { region } : {}), backend: target.backend, workspace: target.workspace,
      projectRoot, fileCount: files.length, providers, engineVersion, engineVersionSource, inputs: derived.shown,
      policyVersion: contract.policyVersion, unitHash, manifestHash: manifest.manifestHash,
      contractSha256: pilotContractSha256(contract),
      unit: pilotUnitOf({ provider: spec.id, contractSha256: pilotContractSha256(contract), environment, target }),
    },
    request,
    manifest,
    gaps: [
      ...(engine.id === "TERRAFORM" ? ["Every module this change calls is a local folder inside the project, so its code is fingerprinted with the project files; there are no other dependencies."] : []),
      ...(derived.shown.some((i) => i.source === "ENVIRONMENT")
        ? ["Values for " + derived.shown.filter((i) => i.source === "ENVIRONMENT").map((i) => i.name).join(", ") + " come from environment variables: they are named here, not fingerprinted. The sealed plan binds what they produced."]
        : []),
      "These are local preparation files. They are not qualification evidence and prove nothing about the cloud.",
      ...(PATHS[spec.id].secondary === null ? [PATHS[spec.id].secondaryGap] : []),
    ],
    next,
  };
}

/** The inputs of a Terraform root module or a CDK assembly, as identities and as the plain list the review shows. */
function deriveInputs(engine: EngineId, projectRoot: string, files: ArtifactManifest["files"], env: NodeJS.ProcessEnv):
  { inputs: ManifestInput[]; shown: PreparedInput[] } | { refusal: PrepareRefusal } {
  const fileHash = (path: string) => files.find((file) => file.path === path)?.sha256;
  const identity = (name: string, source: Record<string, unknown>) => sha256(canonicalJson({ purpose: "pilot-input", engine, name, source } as never));
  const inputs: ManifestInput[] = [];
  const shown: PreparedInput[] = [];
  const unset: string[] = [];
  if (engine === "TERRAFORM") {
    let sources: ReturnType<typeof variableSources>;
    try {
      checkModules(projectRoot);
      sources = variableSources(projectRoot, env);
    } catch (error) {
      if (error instanceof TerraformConfigError) return { refusal: refuse(error.code, "OPERATOR", error.message) };
      throw error;
    }
    for (const variable of sources) {
      const { source } = variable;
      if (source.kind === "UNSET") { unset.push(variable.name); continue; }
      const from = source.kind === "ENVIRONMENT" ? source.variable : source.file;
      inputs.push({ name: variable.name, identity: identity(variable.name, source.kind === "ENVIRONMENT" ? { ...source } : { ...source, sha256: fileHash(from) }) });
      shown.push({ name: variable.name, source: source.kind, from });
    }
    if (unset.length > 0) {
      return { refusal: refuse("INPUT_UNSET", "OPERATOR", "These Terraform variables have no value: " + unset.join(", ") +
        ". Give each a default, an entry in terraform.tfvars, or set ALZ_DISCOVERY_TF_VAR_<name> where the console runs. Values are never read or stored here.") };
    }
  } else if (engine === "BICEP") {
    // Bicep: the stack is created from the compiled template with no parameters file, so every parameter takes its default; nothing passes another value.
  } else {
    // CDK: the change set takes each template parameter's default; nothing passes another value.
    for (const file of readdirSync(projectRoot).filter((name) => name.endsWith(".template.json")).sort()) {
      let parameters: unknown;
      try { parameters = (JSON.parse(readFileSync(join(projectRoot, file), "utf8")) as { Parameters?: unknown }).Parameters; } catch { parameters = undefined; }
      if (!parameters || typeof parameters !== "object") continue;
      for (const [parameter, body] of Object.entries(parameters as Record<string, unknown>)) {
        const name = file.replace(/\.template\.json$/, "") + "/" + parameter;
        if (!body || typeof body !== "object" || !Object.hasOwn(body, "Default")) { unset.push(name); continue; }
        inputs.push({ name, identity: identity(name, { kind: "DEFAULT", file, sha256: fileHash(file) }) });
        shown.push({ name, source: "DEFAULT", from: file });
      }
    }
    if (unset.length > 0) {
      return { refusal: refuse("INPUT_UNSET", "OPERATOR", "These template parameters have no default, and the pilot passes no parameter values: " + unset.join(", ") +
        ". Give each a default in the CDK app and synthesize again.") };
    }
  }
  return { inputs, shown };
}

/** Writes the request, manifest and preparation record, each named by the manifest hash, private and all-or-nothing. */
export function writePreparation(prepared: Prepared, outDir: string = join(repoPaths().root, ".runs", "pilot")):
  { request: string; manifest: string; record: string } {
  const dir = join(outDir, prepared.summary.environment);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tag = prepared.manifest.manifestHash.slice(0, 16);
  const paths = {
    request: join(dir, "request-" + tag + ".json"),
    manifest: join(dir, "manifest-" + tag + ".json"),
    record: join(dir, "preparation-" + tag + ".json"),
  };
  const record = { ...prepared.summary, requestFile: paths.request, manifestFile: paths.manifest, gaps: prepared.gaps, next: prepared.next };
  const contents: Array<[string, unknown]> = [[paths.request, prepared.request], [paths.manifest, prepared.manifest], [paths.record, record]];
  const staged: string[] = [];
  // Undo only what this call put in place: a file that was already there (same hash, same content) is kept.
  const placed: string[] = [];
  try {
    for (const [path, value] of contents) {
      const temp = path + ".partial-" + process.pid;
      writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      staged.push(temp);
    }
    contents.forEach(([path], index) => {
      const existed = existsSync(path);
      renameSync(staged[index], path);
      if (!existed) placed.push(path);
    });
  } catch (error) {
    for (const temp of staged) rmSync(temp, { force: true });
    for (const path of placed) rmSync(path, { force: true });
    throw error;
  }
  return paths;
}

/** True when the project still matches a prepared manifest; a changed project needs a new preparation. */
export function preparationIsCurrent(manifest: ArtifactManifest, projectRoot: string): boolean {
  try {
    return canonicalJson(captureProjectFiles(resolve(projectRoot))) === canonicalJson(manifest.files) && existsSync(projectRoot);
  } catch {
    return false;
  }
}
