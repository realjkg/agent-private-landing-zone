import { createPrivateKey, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { signApproval } from "../apply/approval.js";
import { ENVIRONMENTS, stripInvisible } from "../apply/constants.js";
import {
  contractRefusal, inspectPilotContract, isKillSwitchActive, loadPilotContract, pilotContractSha256, repoPaths, requireNotApplied, targetForEnvironment, writeQualificationEvidence, type Refusal,
} from "../apply/contract.js";
import { channelMismatchMessage } from "../apply/channel.js";
import { qualifyApply, runApply, sealPreview, type ApplyDeps, type SealRequest } from "../apply/driver.js";
import { RECOVERY_FILE_NAMES, engineOf, engineSpec, type EngineNotices } from "../apply/engine-spec.js";
import { assertApplyEvidence } from "../apply/evidence.js";
import { attestedClientId, checkApplyIdentities, verifyIdentityTargets } from "../apply/identities.js";
import { holdsReservation } from "../apply/ledger.js";
import { accountFieldsOf, specOf } from "../apply/provider.js";
import { loadSealedPlan, reviewBundleOf, verifyReviewBundle, type LoadedPlan } from "../apply/seal.js";
import type { ApplyEnvironment, ApplyIdentity, ApplyOutcome, PilotChannel, PilotContract, SealedPlan, SignedApproval } from "../apply/types.js";
import { isRecord, SAFE_OPERATOR } from "../teardown/driver/human.js";
import { sweepStale } from "../teardown/driver/cleanup.js";
import { verifyManifest, type ArtifactManifest } from "../teardown/manifest.js";
import { approvedToolDirs, resolveExecutable } from "../tools/child-env.js";
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
  "  ./alz apply qualify --request REQUEST.json --manifest MANIFEST.json",
  "  ./alz apply seal --request REQUEST.json --manifest MANIFEST.json",
  "  ./alz apply approve --bundle REVIEW_BUNDLE.json --key APPROVER_KEY.pem --approver ID",
  "  ./alz apply apply --request REQUEST.json --manifest MANIFEST.json --sealed SEALED_PLAN --approval APPROVAL.json [--approval APPROVAL.json ...]",
  "  ./alz apply status [--sealed SEALED_PLAN]",
  "  ./alz apply pin",
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
} & Pick<ApplyDeps, "contractPath" | "contractPinPath" | "qualificationDir" | "evidenceDir" | "nonces" | "scratchParent" | "toolDirs">;

/** Why a command ended, without parsing text: a refusal's code and outcome, or a CLI error's code. */
export type ApplyReport = { code: string; message: string; outcome?: ApplyOutcome };

type Flags = { single: readonly string[]; repeated?: readonly string[]; optional?: readonly string[] };
const SUBCOMMANDS: Readonly<Record<string, Flags>> = {
  qualify: { single: ["request", "manifest"] },
  seal: { single: ["request", "manifest"] },
  approve: { single: ["bundle", "key", "approver"] },
  apply: { single: ["request", "manifest", "sealed"], repeated: ["approval"] },
  status: { single: [], optional: ["sealed"] },
  pin: { single: [] },
  preflight: { single: ["environment"], optional: ["contract"] },
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
): Promise<{ request: SealRequest; target: ResolvedTarget; who: string } | number> {
  const file = readRequest("seal", flags.request[0]);
  const manifest = readManifest(flags.manifest[0]);
  if (!manifest) return blockedManifest(out);
  const { policyVersion, resolved } = file;
  if (typeof policyVersion !== "string" || !isRecord(resolved)) return fail("APPLY_INPUT_INVALID", "request.policyVersion and request.resolved are required");
  const who = operatorId(deps);
  // The contract's engine says what runs. A contract that does not load is refused by the driver after the prompts, as before.
  const notices = engineNotices(deps);

  terminal.write([
    "", heading(notices),
    "  account         " + file.target.account, "  backend         " + file.target.backend, "  workspace       " + file.target.workspace,
    "  manifest hash   " + manifest.manifestHash, reads(notices),
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
    target: file.target, who,
    request: {
      invocation: { operatorId: who, interactiveSession: true, confirmedTarget: { ...file.target }, confirmedAt: now().toISOString() },
      environment: file.environment, target: file.target, channel: deps.channel ?? "CLI", manifest, projectRoot: file.projectRoot, policyVersion, resolved: resolved as never,
    },
  };
}

const sealCommand: Command = async (flags, terminal, deps, out) => {
  const gate = await confirmProjectCode(flags, terminal, deps, out, (n) => n.sealHeading, (n) => n.sealReads);
  if (typeof gate === "number") return gate;
  const result = await sealPreview(gate.request, { env: deps.env ?? process.env, now: deps.now, ...driverPaths(deps) });
  if (!result.ok) return blocked(result, out);
  const { sealed } = result;
  // The bundle approvers review. It holds no secret, so it can leave the operator's machine; the sealed plan itself cannot.
  const reviewBundlePath = result.path + ".review.json";
  writeFileSync(reviewBundlePath, JSON.stringify(reviewBundleOf(sealed), null, 2) + "\n", { mode: 0o600 });
  out.say(JSON.stringify({
    artifactSha256: sealed.artifactSha256, environment: sealed.environment, target: sealed.target, releaseIdentity: sealed.releaseIdentity,
    manifestHash: sealed.manifestHash, sealedPlanPath: result.path, reviewBundlePath, changes: sealed.changes,
  }, null, 2) + "\n");
  return EXIT.PASS;
};

/** The locations and seams the CLI hands the driver; everything else the driver defaults from the repository. */
const driverPaths = (deps: ApplyCliDeps) => ({
  contractPath: deps.contractPath, contractPinPath: deps.contractPinPath, qualificationDir: deps.qualificationDir,
  scratchParent: deps.scratchParent, toolDirs: deps.toolDirs,
});

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
  const ran = await qualifyApply(gate.request, { env, now, ...driverPaths(deps) });
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
  const who = operatorId(deps);

  // One phrase carries the environment, the artifact and the target, so what is typed is what runs.
  const phrase = "APPLY " + request.environment + " " + sealedPlan.sealed.artifactSha256.slice(0, 12) + " " + targetString(request.target);
  terminal.write([
    "", "APPLY A SEALED PLAN TO " + request.environment + " (this changes real infrastructure; there is no undo here)",
    "  account         " + request.target.account, "  backend         " + request.target.backend, "  workspace       " + request.target.workspace,
    "  artifact        " + sealedPlan.sealed.artifactSha256, "  manifest hash   " + manifest.manifestHash,
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
  }, { env: deps.env ?? process.env, now, evidenceDir: deps.evidenceDir, nonces: deps.nonces, ...driverPaths(deps) });
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

/** What no check here can show: only a real backend run, attested by a person, moves it (docs/act-pilot-bootstrap.md). */
const AUTHENTICATION_STATUS = "SIMULATED: identity separation is not verified on a real backend until `qualify` has run against a real DEV target";

/**
 * Read-only and offline: whether this machine is ready for the environment named, before any seal. It checks the contract's
 * shape (even a draft or an example that is not enabled or pinned), that each identity the engine needs is configured,
 * distinct and aimed at the environment's account, that the engine's tools are installed in approved directories, and the
 * kill switch. It calls no cloud and starts no engine, prints names and never values, and enables nothing.
 */
const preflightCommand: Command = async (flags, _terminal, deps, out) => {
  const environment = flags.environment[0];
  if (!(ENVIRONMENTS as readonly string[]).includes(environment)) fail("APPLY_ARGUMENT_INVALID", "--environment must be DEV, QA or PROD");
  const path = flags.contract?.[0] ?? deps.contractPath ?? repoPaths().contract;
  // Missing owner configuration is a BLOCKED readiness item, not a failed user-entered request path.
  // Preflight remains offline, read-only and fail-closed; it never synthesizes or enables a contract.
  let inspected: ReturnType<typeof inspectPilotContract>;
  try {
    inspected = inspectPilotContract(readInput(path, "the pilot contract"));
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    const detail = existsSync(path)
      ? "The pilot contract exists but cannot be read as valid JSON. Ask the pilot owner to correct it."
      : "The pilot contract has not been installed by the owner. Infrastructure ACT remains disabled.";
    out.say(JSON.stringify({
      environment, ready: false, authentication: AUTHENTICATION_STATUS,
      checks: [{ check: "contract shape (provider, engine, targets, approvals, approvers)", ok: false, detail }],
    }, null, 2) + "\n");
    return EXIT.BLOCKED;
  }
  const checks: { check: string; ok: boolean; detail?: string }[] = [];
  const add = (check: string, ok: boolean, detail?: string) => { checks.push({ check, ok, ...(detail === undefined ? {} : { detail }) }); };
  add("contract shape (provider, engine, targets, approvals, approvers)", inspected.ok, inspected.ok ? undefined : inspected.reason);
  if (inspected.ok) {
    const { contract } = inspected;
    const spec = specOf(contract);
    const engine = engineOf(contract);
    const env = deps.env ?? process.env;
    const pinned = loadPilotContract(path, deps.contractPinPath);
    add("pilot contract pinned and enabled (required before seal)", !("reason" in pinned), "reason" in pinned ? pinned.reason : undefined);
    const identities = checkApplyIdentities(env, spec, engine.identities);
    add("identities configured, distinct, no fallback (" + engine.identities.join(", ") + ")", identities.ok, identities.ok ? undefined : identities.message);
    const targets = verifyIdentityTargets(contract, environment as ApplyEnvironment, env, spec, engine.identities);
    add("identities aimed at the " + environment + " account", targets.ok, targets.ok ? undefined : targets.message);
    // Informational: where the contract opts in, sealing itself carries STATE_WRITE's non-secret settings (typed confirmation at seal).
    add("plan will embed STATE_WRITE settings: " + (contract.embedStateWrite === true ? "yes" : "no"), true);
    for (const tool of engine.executables) {
      add("tool " + tool + " installed in an approved directory", resolveExecutable(tool, deps.toolDirs ?? approvedToolDirs(env)) !== undefined);
    }
    add("kill switch absent", !isKillSwitchActive(contract), contract.killSwitchPath);
  }
  const ready = checks.every((c) => c.ok);
  out.say(JSON.stringify({ environment, ready, authentication: AUTHENTICATION_STATUS, checks }, null, 2) + "\n");
  return ready ? EXIT.PASS : EXIT.BLOCKED;
};

const COMMANDS: Readonly<Record<string, Command>> = {
  qualify: qualifyCommand, seal: sealCommand, approve: approveCommand, apply: applyCommand, status: statusCommand, pin: pinCommand,
  preflight: preflightCommand,
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
  if (sub === "status" || sub === "approve" || sub === "pin" || sub === "preflight") return;
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
