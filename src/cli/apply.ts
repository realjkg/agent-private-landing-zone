import { createPrivateKey, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { signApproval } from "../apply/approval.js";
import { COMMIT, ENVIRONMENTS, stripInvisible } from "../apply/constants.js";
import {
  contractRefusal, isKillSwitchActive, loadPilotContract, pilotContractSha256, repoPaths, requireNotApplied, targetForEnvironment, writeQualificationEvidence, type Refusal,
} from "../apply/contract.js";
import { channelMismatchMessage } from "../apply/channel.js";
import { liveRecordOf, readAppliedEvidence } from "../apply/live-record.js";
import { assessReadiness } from "../apply/readiness.js";
import { prepareApply, writePreparation, type Prepared, type PrepareRefusal } from "../apply/prepare.js";
import { qualifyApply, runApply, sealPreview, type ApplyDeps, type SealRequest } from "../apply/driver.js";
import { RECOVERY_FILE_NAMES, engineOf, engineSpec, type EngineNotices } from "../apply/engine-spec.js";
import { assertApplyEvidence } from "../apply/evidence.js";
import { attestedClientId } from "../apply/identities.js";
import { holdsReservation } from "../apply/ledger.js";
import { accountFieldsOf, specOf } from "../apply/provider.js";
import { loadSealedPlan, reviewBundleOf, verifyReviewBundle, type LoadedPlan } from "../apply/seal.js";
import type { ApplyEnvironment, ApplyIdentity, ApplyOutcome, PilotChannel, PilotContract, SealedPlan, SignedApproval } from "../apply/types.js";
import { isRecord, SAFE_OPERATOR } from "../teardown/driver/human.js";
import { sweepStale } from "../teardown/driver/cleanup.js";
import { verifyManifest, type ArtifactManifest } from "../teardown/manifest.js";
import { resolveSourceCommit } from "../util/source-commit.js";
import { identityVariables } from "../tools/identity.js";
import { EXIT, installSignalCleanup, processTerminal, targetString, type HumanTerminal, type PhraseKind } from "./teardown-driver.js";

// The human entry to the pilot apply path (docs/act-pilot-apply.md). The
// operator authorizes, the driver enforces, and agents never initiate: every
// subcommand needs a person at a terminal (the real one, or the console adapter's
// dialog terminal for a request that passed its session-token check), `apply` is
// the only code path that calls `runApply`, and nothing under src/tools,
// src/agent, src/operations or src/operator-ui imports this module except
// src/cli/ui-channel.ts, the console's one bridge (test/apply-boundary.test.ts).
// A workflow runs in ONE channel, CLI or UI, bound into the sealed plan.
// ACT stays DISABLED unless a valid, pinned pilot contract enables it.
// The approver allowlist is in that contract and qualification is verified from
// vault evidence, so neither is a file an operator names.

const APPLY_USAGE = [
  "  ./alz apply prepare --environment DEV|QA|PROD --project PROJECT_DIR [--aws-cli-version X.Y.Z]",
  "  ./alz apply qualify --request REQUEST.json --manifest MANIFEST.json",
  "  ./alz apply seal --request REQUEST.json --manifest MANIFEST.json",
  "  ./alz apply approve --bundle REVIEW_BUNDLE.json --key APPROVER_KEY.pem --approver ID",
  "  ./alz apply apply --request REQUEST.json --manifest MANIFEST.json --sealed SEALED_PLAN --approval APPROVAL.json [--approval APPROVAL.json ...]",
  "  ./alz apply status [--sealed SEALED_PLAN]",
  "  ./alz apply pin",
  "  ./alz apply record-live --sealed SEALED_PLAN",
  "  ./alz apply preflight --environment DEV|QA|PROD [--contract CONTRACT.json]",
  "      A person at the terminal (or a person in the console wizard, which has its own session token). A workflow runs wholly in one of them. Identities come from the contract's engine: ALZ_DISCOVERY_*, ALZ_STATE_*, ALZ_STATE_WRITE_* and ALZ_APPLY_* (Terraform),",
  "      or ALZ_DISCOVERY_*, ALZ_CHANGESET_* and ALZ_APPLY_* (CDK). No flag names an engine; the pinned contract does.",
  "      Exit 0 done, 1 error (nothing spent), 2 BLOCKED (refused before any action), 3 SPENT (approvals consumed or an apply started; read the message before any retry).",
  "      No flag forces, skips, ignores, overrides or pre-answers anything.",
].join("\n");

/** 3: the engine ran, or the approvals were consumed and nothing ran; either way they are spent. The other codes are `EXIT`'s. */
const SPENT = 3;

/**
 * The person at the keyboard. TEST-ONLY SEAMS: every field of `ApplyCliDeps`
 * is a function parameter, so nothing on the command line, in the environment
 * or in a file can reach them and no operator can use them to skip a prompt.
 */
export type ApplyCliDeps = {
  terminal?: HumanTerminal;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Defaults to the operating-system account name. */
  operatorId?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /**
   * Who is invoking: the terminal (`CLI`, the default) or the console adapter (`UI`). Set by the CALLER, never by a flag, a file
   * or the environment. It is sealed into the plan; `approve` and `apply` refuse (`CHANNEL_MISMATCH`) when it differs from the plan's.
   */
  channel?: PilotChannel;
  /** The structured end of a command, for a caller that draws its own screen. Never needed to run, and never changes what is decided. */
  report?: (event: ApplyReport) => void;
  /** Where `prepare` saves its files; defaults to `.runs/pilot` in the repository. */
  preparationDir?: string;
  /** The product source commit. Production reads it from the checkout or the image's build stamp (`resolveSourceCommit`). */
  sourceCommit?: string;
  /** Where `record-live` writes its record; defaults to config/acceptance/evidence in the repository. */
  acceptanceDir?: string;
} & Pick<ApplyDeps, "contractPath" | "contractPinPath" | "qualificationDir" | "evidenceDir" | "nonces" | "scratchParent" | "toolDirs">;

/** Why a command ended, without parsing text: a refusal's code and outcome, or a CLI error's code. */
export type ApplyReport = { code: string; message: string; outcome?: ApplyOutcome; data?: unknown };

type Flags = { single: readonly string[]; repeated?: readonly string[]; optional?: readonly string[] };
const SUBCOMMANDS: Readonly<Record<string, Flags>> = {
  qualify: { single: ["request", "manifest"] },
  seal: { single: ["request", "manifest"] },
  approve: { single: ["bundle", "key", "approver"] },
  apply: { single: ["request", "manifest", "sealed"], repeated: ["approval"] },
  status: { single: [], optional: ["sealed"] },
  pin: { single: [] },
  preflight: { single: ["environment"], optional: ["contract"] },
  prepare: { single: ["environment", "project"], optional: ["aws-cli-version"] },
  "record-live": { single: ["sealed"] },
};
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const CODE_PHRASE = "RUN PROJECT CODE";
/** What the person types when the contract opts in to embedding STATE_WRITE in the plan: one phrase per environment, no flag skips it. */
const embedPhrase = (environment: string): string => "EMBED STATE_WRITE " + environment;
const REQUEST_KEYS: Readonly<Record<string, readonly string[]>> = {
  seal: ["environment", "target", "projectRoot", "policyVersion", "resolved"],
  apply: ["environment", "target", "projectRoot"],
};

type ResolvedTarget = SealedPlan["target"];

class CliError extends Error {}
const fail = (code: string, detail = ""): never => { throw new CliError(code + (detail ? ": " + detail : "")); };
const printable = (text: string): string => stripInvisible(text).replace(CONTROL, "?");

/** Each flag once (the repeated ones any number of times); anything else is refused, whatever it is called. */
function parseFlags(sub: string, args: string[]): Record<string, string[]> {
  const spec = SUBCOMMANDS[sub];
  const known = [...spec.single, ...(spec.repeated ?? []), ...(spec.optional ?? [])];
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]?.startsWith("--") ? args[index].slice(2) : undefined;
    if (name === undefined || !known.includes(name)) {
      fail("APPLY_FLAG_UNKNOWN", JSON.stringify(printable((args[index] ?? "").slice(0, 40))) + ". ./alz apply " + sub + " takes only --" +
        known.join(", --") + "; there is no flag that forces, skips, ignores, overrides or pre-answers anything");
    }
    const value = args[index + 1];
    if (value === undefined || value === "" || value.startsWith("--")) fail("APPLY_ARGUMENT_INVALID", "--" + name);
    if (values.has(name!) && !spec.repeated?.includes(name!)) fail("APPLY_ARGUMENT_INVALID", "--" + name + " given twice");
    values.set(name!, [...(values.get(name!) ?? []), value]);
  }
  for (const name of [...spec.single, ...(spec.repeated ?? [])]) if (!values.has(name)) fail("APPLY_ARGUMENT_REQUIRED", "--" + name);
  return Object.fromEntries(values);
}

/** Parse errors are fixed text: a JSON error can quote the file, and these files describe a real environment. */
function readInput(path: string, label: string): unknown {
  try {
    if (lstatSync(path).size > MAX_INPUT_BYTES) fail("APPLY_INPUT_INVALID", label + " is larger than " + MAX_INPUT_BYTES + " bytes");
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof CliError) throw error;
    return fail("APPLY_INPUT_INVALID", label + " cannot be read as a JSON file");
  }
}

function readTarget(value: unknown): ResolvedTarget {
  const fields = ["account", "backend", "workspace"] as const;
  if (!isRecord(value) || Object.keys(value).length !== fields.length ||
    fields.some((key) => typeof value[key] !== "string" || value[key] === "" || (value[key] as string).length > 512 || CONTROL.test(value[key] as string))) {
    fail("APPLY_INPUT_INVALID", "request.target needs exactly a printable account, backend and workspace");
  }
  const target = value as ResolvedTarget;
  return { account: target.account, backend: target.backend, workspace: target.workspace };
}

/** The request file: a closed set of fields. The invocation, manifest and approvals come from the command, never from a file. */
function readRequest(sub: "seal" | "apply", path: string): Record<string, unknown> & { environment: ApplyEnvironment; target: ResolvedTarget; projectRoot: string } {
  const file = readInput(path, "--request");
  const keys = REQUEST_KEYS[sub];
  if (!isRecord(file) || Object.keys(file).some((key) => !keys.includes(key)) || keys.some((key) => !(key in file))) {
    fail("APPLY_INPUT_INVALID", "--request must be a JSON object with exactly " + keys.join(", ") +
      "; the command supplies the invocation, the manifest and the approvals");
  }
  const request = file as Record<string, unknown>;
  if (!ENVIRONMENTS.includes(request.environment as ApplyEnvironment)) fail("APPLY_INPUT_INVALID", "request.environment must be DEV, QA or PROD");
  if (typeof request.projectRoot !== "string" || request.projectRoot === "") fail("APPLY_INPUT_INVALID", "request.projectRoot is required");
  return { ...request, environment: request.environment as ApplyEnvironment, target: readTarget(request.target), projectRoot: resolve(request.projectRoot as string) };
}

/** The manifest the plan is bound to. An invalid one ends the command with a decision, not an error. */
function readManifest(path: string): ArtifactManifest | undefined {
  const raw = readInput(path, "--manifest");
  try { return verifyManifest(raw); } catch { return undefined; }
}

function operatorId(deps: ApplyCliDeps): string {
  const id = deps.operatorId ?? userInfo().username;
  return SAFE_OPERATOR.test(id) ? id : fail("APPLY_INPUT_INVALID", "the operator account name is not usable as an operator id");
}

/** The person types exactly `expected`. Anything else ends the command. */
async function confirm(terminal: HumanTerminal, expected: string, prompt: string, code: string, kind: PhraseKind): Promise<void> {
  if ((await terminal.ask(prompt, { kind, phrase: expected })) !== expected) fail(code, "what was typed is not the text above. Nothing was run");
}

/** Every line an approver needs: the action, the address and type, and an import, a move or a forget (which leaves the real resource and drops it from state). Output changes are lines of type `output`. */
const changeLines = ({ changes }: Pick<SealedPlan, "changes">): string[] => changes.length === 0 ? ["  (no changes)"]
  : changes.map((change) => "  " + printable(change.action).padEnd(8) + " " + printable(change.address) + " (" + printable(change.type) + ")" +
    (change.importing ? " [importing an existing resource]" : "") + (change.previousAddress ? " [moved from " + printable(change.previousAddress) + "]" : "") +
    (change.action === "FORGET" ? " [removed from state only; the real resource is left]" : ""));

/**
 * The exit code for a refusal. 3 SPENT: the engine ran (the result carries an
 * outcome), or the approvals were consumed and the engine then did not start
 * (the kill switch appeared, or the plan write or spawn failed: nothing ran,
 * but the approvals are gone). 1:
 * nothing ran or was spent, but the cause is not a decision (the engine could
 * not start, the evidence could not be written). 2 BLOCKED: refused before any
 * action.
 */
function blocked(refusal: Refusal, out: Out): number {
  out.complain("BLOCKED " + refusal.code + ": " + refusal.message + "\n");
  out.report({ code: refusal.code, message: refusal.message, ...(refusal.outcome === undefined ? {} : { outcome: refusal.outcome }) });
  if (refusal.outcome !== undefined || refusal.code === "KILL_SWITCH_AFTER_APPROVALS" || refusal.code === "APPROVALS_SPENT") return SPENT;
  return refusal.code === "APPLY_FAILED" || refusal.code === "EVIDENCE_REJECTED" ? EXIT.ERROR : EXIT.BLOCKED;
}

const blockedManifest = (out: Out): number => {
  out.complain("BLOCKED MANIFEST_INVALID: The manifest is not valid or not sealed.\n");
  out.report({ code: "MANIFEST_INVALID", message: "The manifest is not valid or not sealed." });
  return EXIT.BLOCKED;
};

/** The sealed plan, loaded for display, approval or status. The driver verifies it again before applying. */
async function openSealed(path: string): Promise<LoadedPlan | Refusal> {
  const loaded = await loadSealedPlan(path);
  return loaded.ok ? { sealed: loaded.sealed, planBytes: loaded.planBytes } : loaded;
}

const contractFor = (deps: ApplyCliDeps) => loadPilotContract(deps.contractPath, deps.contractPinPath);
/** What the contract's engine tells a person. A contract that does not load is refused by the driver after the prompts, so the prompts are the first engine's. */
const engineNotices = (deps: ApplyCliDeps): EngineNotices => {
  const loaded = contractFor(deps);
  return ("reason" in loaded ? engineSpec("TERRAFORM")! : engineOf(loaded)).notices;
};

// --- seal and qualify ----------------------------------------------------------------------------------------

type Out = { say: (text: string) => void; complain: (text: string) => void; report: (event: ApplyReport) => void };
type Command = (flags: Record<string, string[]>, terminal: HumanTerminal, deps: ApplyCliDeps, out: Out) => Promise<number>;

/** What `seal` and `qualify` share: the request, the manifest, the target typed, and project code allowed. Returns what the driver needs. */
async function confirmProjectCode(
  flags: Record<string, string[]>, terminal: HumanTerminal, deps: ApplyCliDeps, out: Out, heading: (notices: EngineNotices) => string, reads: (notices: EngineNotices) => string,
): Promise<{ request: SealRequest; target: ResolvedTarget; who: string; sourceCommit: string } | number> {
  const file = readRequest("seal", flags.request[0]);
  const manifest = readManifest(flags.manifest[0]);
  if (!manifest) return blockedManifest(out);
  const { policyVersion, resolved } = file;
  if (typeof policyVersion !== "string" || !isRecord(resolved)) return fail("APPLY_INPUT_INVALID", "request.policyVersion and request.resolved are required");
  // Before any phrase is asked: the plan is bound to the product commit, so an unknown or uncommitted one stops here.
  const sourceCommit = sourceCommitFor(deps);
  if (sourceCommit === undefined) {
    return blocked({ ok: false, code: "SOURCE_UNVERIFIED", message: "The product source commit could not be established, so nothing was run. Commit your changes, or run the packaged image." }, out);
  }
  const who = operatorId(deps);
  // The contract's engine says what runs. A contract that does not load is refused by the driver after the prompts, as before.
  const notices = engineNotices(deps);

  terminal.write([
    "", heading(notices),
    "  account         " + file.target.account, "  backend         " + file.target.backend, "  workspace       " + file.target.workspace,
    "  manifest hash   " + manifest.manifestHash, "  product commit  " + sourceCommit, reads(notices),
    "", notices.projectCode ?? "THIS RUNS NO PROJECT CODE: the pilot reads the pre-synthesized assembly and calls the AWS CLI with fixed arguments.",
    "  project root    " + file.projectRoot, "  files bound     " + manifest.files.length,
    "", "Type the target exactly to continue (anything else stops here):", "  " + targetString(file.target), "",
  ].join("\n"));
  await confirm(terminal, targetString(file.target), "target> ", "HUMAN_CONFIRMATION_MISMATCH", "TARGET");
  if (notices.projectCode) {
    terminal.write("\nType " + CODE_PHRASE + " to allow it (anything else stops here):\n\n");
    await confirm(terminal, CODE_PHRASE, "code> ", "PROJECT_CODE_CONFIRMATION_MISMATCH", "RUN_PROJECT_CODE");
  }
  // The contract's opt-in (`embedStateWrite`): the seal step itself carries the state writer's settings, so a person says so before any engine runs.
  const contract = contractFor(deps);
  if (!("reason" in contract) && contract.embedStateWrite === true) {
    const phrase = embedPhrase(file.environment);
    terminal.write([
      "", "WARNING: this contract sets embedStateWrite. The seal step now carries the STATE_WRITE principal's non-secret backend settings",
      "(client id or role ARN, tenant, and the token file PATH; never a secret or the token itself).",
      "  - The sealed plan and the seal-time state read name the state writer.",
      "  - Sealing becomes write-capable at the backend.",
      "  - The plan stays secret-bearing and encrypted.",
      "  - Authentication is SIMULATED: whether Terraform really authenticates state access as STATE_WRITE is unverified until a real-backend run.",
      "Type this line exactly to continue (anything else stops here):", "  " + phrase, "",
    ].join("\n"));
    await confirm(terminal, phrase, "embed> ", "EMBED_STATE_WRITE_CONFIRMATION_MISMATCH", "EMBED_STATE_WRITE");
  }

  const now = deps.now ?? (() => new Date());
  return {
    target: file.target, who, sourceCommit,
    request: {
      invocation: { operatorId: who, interactiveSession: true, confirmedTarget: { ...file.target }, confirmedAt: now().toISOString() },
      environment: file.environment, target: file.target, channel: deps.channel ?? "CLI", manifest, projectRoot: file.projectRoot, policyVersion, resolved: resolved as never,
    },
  };
}

const sealCommand: Command = async (flags, terminal, deps, out) => {
  const gate = await confirmProjectCode(flags, terminal, deps, out, (n) => n.sealHeading, (n) => n.sealReads);
  if (typeof gate === "number") return gate;
  const result = await sealPreview(gate.request, { env: deps.env ?? process.env, now: deps.now, ...driverPaths(deps, gate.sourceCommit) });
  if (!result.ok) return blocked(result, out);
  const { sealed } = result;
  // The bundle approvers review. It holds no secret, so it can leave the operator's machine; the sealed plan itself cannot.
  const reviewBundlePath = result.path + ".review.json";
  writeFileSync(reviewBundlePath, JSON.stringify(reviewBundleOf(sealed), null, 2) + "\n", { mode: 0o600 });
  out.say(JSON.stringify({
    artifactSha256: sealed.artifactSha256, environment: sealed.environment, target: sealed.target, releaseIdentity: sealed.releaseIdentity,
    manifestHash: sealed.manifestHash, sourceCommit: sealed.sourceCommit, sealedPlanPath: result.path, reviewBundlePath, changes: sealed.changes,
  }, null, 2) + "\n");
  return EXIT.PASS;
};

/** The locations and seams the CLI hands the driver; everything else the driver defaults from the repository. */
const driverPaths = (deps: ApplyCliDeps, sourceCommit: string | undefined = sourceCommitFor(deps)) => ({
  contractPath: deps.contractPath, contractPinPath: deps.contractPinPath, qualificationDir: deps.qualificationDir,
  scratchParent: deps.scratchParent, toolDirs: deps.toolDirs, sourceCommit,
});

/** The product commit this command runs from, or undefined (the driver then refuses with SOURCE_UNVERIFIED). The reason goes to stderr. */
function sourceCommitFor(deps: ApplyCliDeps): string | undefined {
  if (deps.sourceCommit !== undefined) return COMMIT.test(deps.sourceCommit) ? deps.sourceCommit : undefined;
  const found = resolveSourceCommit(repoPaths().root);
  if (found.ok) return found.commit;
  (deps.stderr ?? ((text: string) => { process.stderr.write(text); }))("NOTICE " + found.reason + "\n");
  return undefined;
}

/**
 * The real-engine qualification (docs/act-pilot-apply.md, G2). Run once by a
 * person against the DEV target with the real Terraform: it applies nothing and
 * stores no plan. The code cannot see which principal the cloud authenticated for
 * state and which for resources, so the person attests it from the cloud's own
 * logs, typing the two client ids; only then is the evidence written. The
 * attestation is an operator control, not machine proof.
 */
const qualifyCommand: Command = async (flags, terminal, deps, out) => {
  const gate = await confirmProjectCode(flags, terminal, deps, out, (n) => n.qualifyHeading, (n) => n.qualifyReads);
  if (typeof gate === "number") return gate;
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const ran = await qualifyApply(gate.request, { env, now, ...driverPaths(deps, gate.sourceCommit) });
  if (!ran.ok) return blocked(ran, out);

  const contract = contractFor(deps);
  if ("reason" in contract) return blocked(contractRefusal(contract), out);
  const spec = specOf(contract);
  const engine = engineOf(contract);
  const [first, second] = engine.attests;
  const clientOf = (identity: ApplyIdentity) => identityVariables(env, identity).get(spec.clientIdVariable) ?? "";
  const phrase = "SEPARATED " + clientOf(first) + " " + clientOf(second);
  terminal.write([
    "", "The run finished. Before evidence is written, check the " + spec.logSource + " for this run (not this program's output):",
    ...engine.notices.attestation(spec, clientOf(first), clientOf(second)), "  " + phrase, "",
  ].join("\n"));
  await confirm(terminal, phrase, "attest> ", "QUALIFICATION_ATTESTATION_MISMATCH", "ATTEST");

  const { backend, workspace } = contract.targets.DEV;
  const qualified: { adapterVersion: string; argvDigest: string; engineVersion: string; evidenceHash: string }[] = [];
  for (const adapter of ran.adapters) {
    const evidence = {
      schemaVersion: 1 as const, engine: contract.engine, realEngine: true as const, backendIdentitySeparated: true as const,
      ...accountFieldsOf(spec, contract.targets.DEV), backend, workspace, stateWriteClientId: attestedClientId(env, first, spec), applyClientId: attestedClientId(env, second, spec),
      terraformSha256: ran.terraformSha256, adapterVersion: adapter.adapterVersion, argvDigest: adapter.argvDigest, engineVersion: ran.engineVersion, qualifiedAt: now().toISOString(),
    };
    const written = await writeQualificationEvidence(evidence, spec, deps.qualificationDir);
    if (!written.ok) return blocked(written, out);
    qualified.push({ adapterVersion: adapter.adapterVersion, argvDigest: adapter.argvDigest, engineVersion: ran.engineVersion, evidenceHash: written.evidenceHash });
  }
  out.say(JSON.stringify({ qualified }, null, 2) + "\n");
  return EXIT.PASS;
};

// --- approve -------------------------------------------------------------------------------------------------

/** The key comes from the file the person names. Never from the environment, and never a file other users can read. */
function readApproverKey(path: string): string {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 16_384) fail("APPLY_KEY_INVALID", "the approver key must be a regular file only you can read (mode 0600)");
    const pem = readFileSync(path, "utf8");
    if (createPrivateKey(pem).asymmetricKeyType !== "ed25519") fail("APPLY_KEY_INVALID", "the approver key must be an Ed25519 private key");
    return pem;
  } catch (error) {
    if (error instanceof CliError) throw error;
    return fail("APPLY_KEY_INVALID", "the approver key cannot be read as an Ed25519 private key file");
  }
}

/** An approver needs no evidence key: the review bundle, the contract and their own key file are enough. */
const approveCommand: Command = async (flags, terminal, deps, out) => {
  const approverId = flags.approver[0];
  if (!SAFE_OPERATOR.test(approverId)) fail("APPLY_INPUT_INVALID", "--approver is not a usable approver id");
  const privateKeyPem = readApproverKey(flags.key[0]);
  const contract = contractFor(deps);
  if ("reason" in contract) return blocked(contractRefusal(contract), out);
  const opened = verifyReviewBundle(readInput(flags.bundle[0], "--bundle"));
  if (!opened.ok) return blocked(opened, out);
  const { bundle } = opened;
  // One channel per workflow: refused before the approver is asked anything or the key is used.
  if (bundle.channel !== (deps.channel ?? "CLI")) {
    return blocked({ ok: false, code: "CHANNEL_MISMATCH", message: channelMismatchMessage(bundle.channel) }, out);
  }
  const pinned = targetForEnvironment(contract, bundle.environment, bundle.target);
  if (!pinned.ok) return blocked(pinned, out);

  const now = (deps.now ?? (() => new Date()))();
  const expiresAt = new Date(now.getTime() + contract.maxApprovalAgeMinutes * 60_000);
  const phrase = "APPROVE " + bundle.environment + " " + bundle.artifactSha256.slice(0, 12);
  terminal.write([
    "", "APPROVE AN APPLY OF THIS EXACT PLAN TO " + bundle.environment + " (your signature, valid until " + expiresAt.toISOString() + ", usable once)",
    "  artifact        " + bundle.artifactSha256, "  manifest hash   " + bundle.manifestHash,
    "  target          " + targetString(bundle.target), "  approver        " + approverId, "  changes",
    ...changeLines(bundle), "", "The bundle's hashes match the artifact above (recomputed here, not trusted).",
    "Type " + phrase + " to sign (anything else stops here):", "",
  ].join("\n"));
  await confirm(terminal, phrase, "approve> ", "APPLY_CONFIRMATION_MISMATCH", "APPROVE");

  out.say(JSON.stringify(signApproval({
    schemaVersion: 1, artifactSha256: bundle.artifactSha256, environment: bundle.environment, target: bundle.target, approverId,
    issuedAt: now.toISOString(), expiresAt: expiresAt.toISOString(), nonce: randomBytes(16).toString("hex"),
  }, privateKeyPem), null, 2) + "\n");
  return EXIT.PASS;
};

// --- apply ---------------------------------------------------------------------------------------------------

/** The only place `runApply` is called. */
const applyCommand: Command = async (flags, terminal, deps, out) => {
  const request = readRequest("apply", flags.request[0]);
  const manifest = readManifest(flags.manifest[0]);
  const approvals = flags.approval.map((path) => {
    const value = readInput(path, "--approval");
    return isRecord(value) ? value as unknown as SignedApproval : fail("APPLY_INPUT_INVALID", "--approval must be a JSON object");
  });
  if (!manifest) return blockedManifest(out);
  const sealedPlan = await openSealed(flags.sealed[0]);
  if (!("sealed" in sealedPlan)) return blocked(sealedPlan, out);
  if (sealedPlan.sealed.channel !== (deps.channel ?? "CLI")) {
    return blocked({ ok: false, code: "CHANNEL_MISMATCH", message: channelMismatchMessage(sealedPlan.sealed.channel) }, out);
  }
  // Before anyone types the phrase: a plan applies only from the product commit that sealed it (the driver checks again).
  const sourceCommit = sourceCommitFor(deps);
  if (sourceCommit !== sealedPlan.sealed.sourceCommit) {
    return blocked(sourceCommit === undefined
      ? { ok: false, code: "SOURCE_UNVERIFIED", message: "The product source commit could not be established, so nothing was run or consumed." }
      : { ok: false, code: "SOURCE_CHANGED", message: "This plan was sealed from product commit " + sealedPlan.sealed.sourceCommit.slice(0, 12) + ", but " +
          sourceCommit.slice(0, 12) + " is running. Nothing was consumed. Apply from the commit that sealed it, or seal and approve a new plan." }, out);
  }
  const who = operatorId(deps);

  // One phrase carries the environment, the artifact and the target, so what is typed is what runs.
  const phrase = "APPLY " + request.environment + " " + sealedPlan.sealed.artifactSha256.slice(0, 12) + " " + targetString(request.target);
  terminal.write([
    "", "APPLY A SEALED PLAN TO " + request.environment + " (this changes real infrastructure; there is no undo here)",
    "  account         " + request.target.account, "  backend         " + request.target.backend, "  workspace       " + request.target.workspace,
    "  artifact        " + sealedPlan.sealed.artifactSha256, "  manifest hash   " + manifest.manifestHash, "  product commit  " + sealedPlan.sealed.sourceCommit,
    "  approvals       " + approvals.map((a) => printable(String(a.statement?.approverId))).join(", ") + " (the driver verifies each signature)",
    "  changes", ...changeLines(sealedPlan.sealed),
    "", engineNotices(deps).applyNote,
    "Type this line exactly to apply (anything else stops here):", "  " + phrase, "",
  ].join("\n"));
  await confirm(terminal, phrase, "apply> ", "APPLY_CONFIRMATION_MISMATCH", "APPLY");

  const now = deps.now ?? (() => new Date());
  const result = await runApply({
    invocation: { operatorId: who, interactiveSession: true, confirmedTarget: { ...request.target }, confirmedAt: now().toISOString() },
    environment: request.environment, target: request.target, channel: deps.channel ?? "CLI", sealedPlan, manifest, projectRoot: request.projectRoot, approvals,
  }, { env: deps.env ?? process.env, now, evidenceDir: deps.evidenceDir, nonces: deps.nonces, ...driverPaths(deps, sourceCommit) });
  if (!result.ok) return blocked(result, out);
  try {
    out.say(JSON.stringify(assertApplyEvidence(result.evidence), null, 2) + "\n");
  } catch {
    out.complain("The apply succeeded, but its evidence was withheld because it did not pass the redaction check. Record it by hand.\n");
    return SPENT;
  }
  return EXIT.PASS;
};

// --- status --------------------------------------------------------------------------------------------------

/** Read-only: the contract, the kill switch and, for a sealed plan, whether it was applied. It never starts an engine. */
const statusCommand: Command = async (flags, _terminal, deps, out) => {
  const contract = contractFor(deps);
  const report: Record<string, unknown> = "reason" in contract
    ? { act: "DISABLED", code: contract.code, reason: contract.reason }
    : { act: "PILOT_ENABLED", killSwitch: isKillSwitchActive(contract) };
  if (flags.sealed) {
    const opened = await openSealed(flags.sealed[0]);
    if (!("sealed" in opened)) return blocked(opened, out);
    const { artifactSha256, environment } = opened.sealed;
    report.artifact = { artifactSha256, environment, applied: !requireNotApplied(artifactSha256, deps.evidenceDir ?? repoPaths().evidence).ok };
  }
  out.say(JSON.stringify(report, null, 2) + "\n");
  return EXIT.PASS;
};

// --- pin -----------------------------------------------------------------------------------------------------

/**
 * Read-only: the SHA-256 an operator writes to config/act-pilot-contract.sha256 to pin the contract file, and whether
 * that contract is valid. It writes nothing, so pinning stays a reviewed change (docs/act-pilot-apply.md).
 */
const pinCommand: Command = async (_flags, _terminal, deps, out) => {
  const path = deps.contractPath ?? repoPaths().contract;
  const raw = readInput(path, "the pilot contract") as PilotContract;
  const sha256 = pilotContractSha256(raw);
  const scratch = mkdtempSync(join(tmpdir(), "alz-pin-"));
  try {
    const pin = join(scratch, "pin");
    writeFileSync(pin, sha256 + "\n", { mode: 0o600 });
    const loaded = loadPilotContract(path, pin);
    out.say(JSON.stringify("reason" in loaded ? { sha256, valid: false, reason: loaded.reason } : { sha256, valid: true }, null, 2) + "\n");
    return EXIT.PASS;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
};

// --- preflight ---------------------------------------------------------------------------------------------

/**
 * Read-only and offline: whether this machine is ready for the environment named, before any seal. The items, their states,
 * who can fix each one and the next step come from `assessReadiness` (src/apply/readiness.ts), the one readiness definition
 * the console also shows. It calls no cloud, starts no engine, prints names and never values, and enables nothing.
 */
const preflightCommand: Command = async (flags, _terminal, deps, out) => {
  const environment = flags.environment[0];
  if (!(ENVIRONMENTS as readonly string[]).includes(environment)) fail("APPLY_ARGUMENT_INVALID", "--environment must be DEV, QA or PROD");
  const report = await assessReadiness({
    environment: environment as ApplyEnvironment, contractPath: flags.contract?.[0] ?? deps.contractPath, contractPinPath: deps.contractPinPath,
    qualificationDir: deps.qualificationDir, toolDirs: deps.toolDirs, env: deps.env ?? process.env, now: deps.now,
  });
  out.say(JSON.stringify(report, null, 2) + "\n");
  return report.ready ? EXIT.PASS : EXIT.BLOCKED;
};


// --- prepare -----------------------------------------------------------------------------------------------

const NEXT_COMMAND: Readonly<Record<"qualify" | "seal", string>> = { qualify: "./alz apply qualify", seal: "./alz apply seal" };

/** The readable review of a preparation: what was bound, what is still missing, and what the files are (and are not). */
function preparationReview(prepared: Prepared): string {
  const s = prepared.summary;
  return [
    "", "PREPARED (" + s.label + ": local files, not qualification evidence)",
    "  provider        " + s.provider, "  engine          " + s.engine + " (" + s.path.toLowerCase() + " path)",
    "  environment     " + s.environment, "  account         " + s.account,
    ...(s.region ? ["  region          " + s.region] : []),
    "  backend         " + s.backend, "  workspace       " + s.workspace,
    "  project         " + s.projectRoot + " (" + s.fileCount + " files)",
    ...s.providers.map((p) => "  provider pin    " + p.source + " " + p.version),
    "  engine version  " + s.engineVersion + " (" + s.engineVersionSource.toLowerCase().replace(/_/g, " ") + ")",
    ...s.inputs.map((i) => "  input           " + i.name + " from " + i.from + (i.source === "DEFAULT" ? " (default)" : "")),
    "  policy version  " + s.policyVersion, "  unit hash       " + s.unitHash, "  manifest hash   " + s.manifestHash,
    ...(prepared.gaps.length ? ["", "Known gaps:", ...prepared.gaps.map((gap) => "  - " + gap)] : []),
  ].join("\n") + "\n";
}

/**
 * Writes the seal request and artifact manifest for one project from the pinned contract, so an operator never authors them
 * by hand (docs/act-pilot-apply.md). Local and offline: it reads the contract, the project folder, the lock file and
 * qualification records, runs no engine, assumes no role, seals nothing, approves nothing and enables nothing. The engine
 * is the contract's; a missing value is asked for only when the person can supply it, and never invented.
 */
const prepareCommand: Command = async (flags, terminal, deps, out) => {
  const prepDeps = {
    contractPath: deps.contractPath, pinPath: deps.contractPinPath, qualificationDir: deps.qualificationDir, toolDirs: deps.toolDirs,
    env: deps.env ?? process.env,
  };
  const input = { environment: flags.environment[0], projectRoot: flags.project[0], awsCliVersion: flags["aws-cli-version"]?.[0] };
  let result: Prepared | PrepareRefusal = await prepareApply(input, prepDeps);
  if (!result.ok && result.code === "ENGINE_VERSION_REQUIRED" && input.awsCliVersion === undefined) {
    // The one value an operator can supply: the AWS CLI version they will run, read from `aws --version` by them, not by us.
    terminal.write("\n" + result.message + "\n");
    const typed = (await terminal.ask("AWS CLI version (for example 2.27.10): ")).trim();
    if (typed) result = await prepareApply({ ...input, awsCliVersion: typed }, prepDeps);
  }
  if (!result.ok) {
    out.say("BLOCKED " + result.code + " (" + result.blocker.toLowerCase() + " prerequisite): " + result.message + "\n" +
      (result.alternative ? "  Alternative: " + result.alternative + "\n" : ""));
    out.report({ code: result.code, message: result.message, data: { blocker: result.blocker, ...(result.alternative ? { alternative: result.alternative } : {}) } });
    return EXIT.BLOCKED;
  }
  const written = writePreparation(result, deps.preparationDir);
  out.say(preparationReview(result) + "\nSaved (private to this account):\n  request   " + written.request + "\n  manifest  " + written.manifest +
    "\n  record    " + written.record + "\n\n" + (result.next.step === "blocked"
      ? "NEXT BLOCKED (" + result.next.blocker.toLowerCase() + " prerequisite): " + result.next.reason + "\n"
      : "NEXT " + NEXT_COMMAND[result.next.step] + " --request " + written.request + " --manifest " + written.manifest + "\n  " + result.next.reason + "\n"));
  out.report({
    code: "PREPARED", message: "Prepared " + result.summary.engine + " for " + result.summary.environment + ".",
    data: { files: written, summary: result.summary, gaps: result.gaps, next: result.next, request: result.request, manifest: result.manifest },
  });
  return EXIT.PASS;
};

// --- record-live -----------------------------------------------------------------------------------------

/**
 * Turns an owner-run apply that SUCCEEDED into the live acceptance record for the execute step (config/acceptance/journeys.json).
 * It reads the apply's own evidence from the encrypted ledger, shows what ran, and asks the person who ran it to attest that it
 * reached the real account. Then it writes identifiers and hashes only, never a value, for the owner to review and commit.
 * It starts no engine and changes nothing in any cloud. The attestation is the person's, as in `qualify`.
 */
const recordLiveCommand: Command = async (flags, terminal, deps, out) => {
  const contract = contractFor(deps);
  if ("reason" in contract) return blocked(contractRefusal(contract), out);
  const opened = await openSealed(flags.sealed[0]);
  if (!("sealed" in opened)) return blocked(opened, out);
  const { sealed } = opened;
  const evidence = await readAppliedEvidence(sealed.artifactSha256, deps.evidenceDir ?? repoPaths().evidence);
  if (!evidence) fail("LIVE_RECORD_UNAVAILABLE", "this plan has no finished apply evidence. A record is made only from an apply that ran and was recorded");
  const who = operatorId(deps);
  const now = (deps.now ?? (() => new Date()))();
  const made = liveRecordOf(evidence!, contract, who, now);
  if (!made.ok) return fail("LIVE_RECORD_UNAVAILABLE", made.reason);
  const { record } = made;
  const phrase = "LIVE " + record.environment + " " + record.artifactSha256.slice(0, 12);
  terminal.write([
    "", "RECORD LIVE ACCEPTANCE OF THE EXECUTE STEP (" + record.cloud + " " + record.engine + ")",
    "  environment     " + record.environment, "  account         " + record.target.account, "  backend         " + record.target.backend,
    "  workspace       " + record.target.workspace, "  artifact        " + record.artifactSha256, "  product commit  " + record.sourceCommit,
    "  outcome         " + record.outcome + " at " + evidence!.finishedAt,
    "", "Type this only if this apply ran against the real " + record.cloud + " account above, not a test or a fake engine.",
    "It is your attestation, as in qualify, and it is written into the record with your name:", "  " + phrase, "",
  ].join("\n"));
  await confirm(terminal, phrase, "live> ", "LIVE_ATTESTATION_MISMATCH", "ATTEST");
  const dir = deps.acceptanceDir ?? join(repoPaths().root, "config", "acceptance", "evidence");
  const path = join(dir, [record.cloud, record.engine, "execute", record.environment, record.artifactSha256.slice(0, 12)].join("-").toLowerCase() + ".json");
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(path, JSON.stringify(record, null, 2) + "\n", { mode: 0o644, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("LIVE_RECORD_EXISTS", "a record for this artifact is already written at " + path + "; it is never overwritten");
    throw error;
  }
  out.say(JSON.stringify({ written: path, record, next: "Review the record, commit it, and cite it as liveEvidence on the execute step in config/acceptance/journeys.json." }, null, 2) + "\n");
  return EXIT.PASS;
};

const COMMANDS: Readonly<Record<string, Command>> = {
  qualify: qualifyCommand, seal: sealCommand, approve: approveCommand, apply: applyCommand, status: statusCommand, pin: pinCommand,
  preflight: preflightCommand, prepare: prepareCommand, "record-live": recordLiveCommand,
};

/** Where `alz-preview-*` directories live and what a crashed apply leaves in them. */
function scratchHoldsRecovery(parent: string): boolean {
  try {
    return readdirSync(parent).filter((name) => name.startsWith("alz-preview-")).some((name) =>
      RECOVERY_FILE_NAMES.some((file) => [join(parent, name, file), join(parent, name, "work", file)].some((path) => existsSync(path))));
  } catch { return false; }
}

/**
 * The stale-directory sweep for the commands that make scratch (qualify, seal, apply), never `status`. It is skipped,
 * with a notice, while the ledger holds a reservation (an apply may be running, or may have died) or a scratch
 * directory holds errored.tfstate or crash.log: those can be the only record of what an apply did, and an owner reviews
 * them first (docs/act-pilot-apply.md).
 */
async function sweepUnlessHeld(sub: string, deps: ApplyCliDeps, out: Out): Promise<void> {
  if (sub === "status" || sub === "approve" || sub === "pin" || sub === "preflight" || sub === "prepare" || sub === "record-live") return;
  const parent = deps.scratchParent ?? tmpdir();
  const held = scratchHoldsRecovery(parent) ? "a scratch directory holds errored.tfstate or crash.log"
    : await holdsReservation(deps.evidenceDir ?? repoPaths().evidence) ? "the apply ledger holds a reservation" : undefined;
  if (held) out.complain("NOTICE the stale scratch sweep was skipped because " + held + ". Review it by hand (docs/act-pilot-apply.md); nothing was removed.\n");
  else sweepStale(parent);
}

/** Exit codes: see APPLY_USAGE and `blocked`. */
export async function runApplyCommand(args: string[], deps: ApplyCliDeps = {}): Promise<number> {
  const out: Out = {
    say: deps.stdout ?? ((text: string) => { process.stdout.write(text); }),
    complain: deps.stderr ?? ((text: string) => { process.stderr.write(text); }),
    report: deps.report ?? (() => undefined),
  };
  try {
    // A person at a terminal, on input and output, before any file is read. No flag, file or variable waives this.
    const terminal = deps.terminal ?? processTerminal();
    if (!terminal.stdinIsTTY || !terminal.stdoutIsTTY) {
      fail("HUMAN_TERMINAL_REQUIRED", "pilot apply commands are run by a person at an interactive terminal (stdin and stdout). " +
        "Nothing was read or run, and there is no way to bypass this");
    }
    const [sub = "", ...rest] = args;
    if (!Object.hasOwn(SUBCOMMANDS, sub)) fail("APPLY_SUBCOMMAND_UNKNOWN", "use one of " + Object.keys(SUBCOMMANDS).join(", ") + "\n" + APPLY_USAGE);
    const flags = parseFlags(sub, rest);
    const removeHandlers = installSignalCleanup();
    try {
      // Scratch directories (decrypted plans) a SIGKILL or a crash left behind, as the teardown CLI sweeps them.
      await sweepUnlessHeld(sub, deps, out);
      return await COMMANDS[sub](flags, terminal, deps, out);
    } finally {
      removeHandlers();
    }
  } catch (error) {
    // Only messages this module wrote. Anything else is reported by name, never by text.
    const text = error instanceof CliError ? error.message : "APPLY_UNEXPECTED_ERROR";
    out.complain(text + "\n");
    out.report({ code: /^[A-Z][A-Z0-9_]*/.exec(text)?.[0] ?? "APPLY_UNEXPECTED_ERROR", message: text });
    return EXIT.ERROR;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runApplyCommand(process.argv.slice(2)).then((code) => { process.exitCode = code; }, () => {
    console.error("APPLY_UNEXPECTED_ERROR");
    process.exitCode = EXIT.ERROR;
  });
}
