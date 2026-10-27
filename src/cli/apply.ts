import { createPrivateKey, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { REQUESTER_MAY_APPROVE, approverIsRequester, requesterKeyRefusal, requesterPublicKey, signApproval, verifyRequestSignature } from "../apply/approval.js";
import { buildCleanupProposal, proposalLines, signCleanupProposal, verifyCleanupProposal, type CleanupProposal } from "../apply/cleanup-proposal.js";
import { buildLifecycleReport, lifecycleReportProblems } from "../apply/lifecycle-report.js";
import { loadRunRecords, observeRun, verifyProposalLeftovers } from "../apply/observe.js";
import { readLeftoversRecord, readObservationRecord } from "../apply/run-records.js";
import { readCleanupEvidence } from "../apply/ledger.js";
import { actGateId } from "../qualification/release-admission.js";
import { COMMIT, ENVIRONMENTS, stripInvisible } from "../apply/constants.js";
import {
  contractRefusal, isKillSwitchActive, loadPilotContract, pilotContractSha256, repoPaths, requireNotApplied, targetForEnvironment, writeQualificationEvidence, type Refusal,
} from "../apply/contract.js";
import { channelMismatchMessage } from "../apply/channel.js";
import { tagLine } from "../apply/unit.js";
import { liveRecordOf, readAppliedEvidence, type LiveAcceptanceRecord } from "../apply/live-record.js";
import { admissionRecordOf, buildPreviewGateEvidence } from "../apply/preview-evidence.js";
import { buildRecoveryEvidence, recoveryAdmissionRecordOf } from "../apply/recovery-record.js";
import { assessReadiness } from "../apply/readiness.js";
import { checkDraftContract, contractCheckLines } from "../apply/contract-check.js";
import { prepareApply, writePreparation, type Prepared, type PrepareRefusal } from "../apply/prepare.js";
import { qualifyApply, runApply, runCleanup, sealPreview, type ApplyDeps, type SealRequest } from "../apply/driver.js";
import { RECOVERY_FILE_NAMES, engineOf, engineSpec, type EngineNotices } from "../apply/engine-spec.js";
import { assertApplyEvidence } from "../apply/evidence.js";
import { attestedClientId } from "../apply/identities.js";
import { holdsReservation } from "../apply/ledger.js";
import { accountFieldsOf, specOf } from "../apply/provider.js";
import { engineBinaryChange, loadSealedPlan, reviewBundleOf, verifyReviewBundle, type LoadedPlan } from "../apply/seal.js";
import type { ApplyEnvironment, ApplyIdentity, ApplyOutcome, PilotChannel, PilotContract, SealedPlan, SignedApproval } from "../apply/types.js";
import type { AwsCli } from "../observe/verify.js";
import type { ArmHttp } from "../observe/azure-rest.js";
import { isRecord, SAFE_OPERATOR } from "../teardown/driver/human.js";
import { sweepStale } from "../teardown/driver/cleanup.js";
import { canonicalJson, verifyManifest, type ArtifactManifest } from "../teardown/manifest.js";
import { sha256 } from "../util/sha256.js";
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
  "  ./alz apply seal --request REQUEST.json --manifest MANIFEST.json --requester ID --key REQUESTER_KEY.pem",
  "  ./alz apply approve --bundle REVIEW_BUNDLE.json --key APPROVER_KEY.pem --approver ID",
  "  ./alz apply apply --request REQUEST.json --manifest MANIFEST.json --sealed SEALED_PLAN --approval APPROVAL.json [--approval APPROVAL.json ...]",
  "  ./alz apply status [--sealed SEALED_PLAN]",
  "  ./alz apply pin",
  "  ./alz apply contract-check --file DRAFT.json",
  "  ./alz apply record-live --sealed SEALED_PLAN",
  "  ./alz apply record-recovery --sealed INTERRUPTED_SEALED_PLAN --resumed RESUMED_SEALED_PLAN --target-hardware-id HOST",
  "  ./alz apply preflight --environment DEV|QA|PROD [--contract CONTRACT.json]",
  "  ./alz apply observe --sealed SEALED_PLAN",
  "  ./alz apply propose-cleanup --sealed SEALED_PLAN --requester ID --key REQUESTER_KEY.pem",
  "  ./alz apply cleanup --proposal PROPOSAL.json --request REQUEST.json --manifest MANIFEST.json --sealed SEALED_PLAN --approval APPROVAL.json [--approval APPROVAL.json ...]",
  "  ./alz apply verify-cleanup --proposal PROPOSAL.json",
  "  ./alz apply preview-evidence --sealed SEALED_PLAN --gate preview:terraform-azure-brownfield --target-hardware-id HOST",
  "  ./alz apply report --sealed SEALED_PLAN [--proposal PROPOSAL.json]",
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
  /** Where `propose-cleanup` saves proposals; defaults to `.runs/apply/cleanup` in the repository. */
  proposalsDir?: string;
  /** Where `report` writes lifecycle reports; defaults to `.runs/apply/reports` in the repository. */
  reportsDir?: string;
  /** Where `preview-evidence` writes a preview gate's evidence; defaults to `.runs/release/preview` in the repository. */
  releaseEvidenceDir?: string;
  /** TEST-ONLY SEAM: the verifier's AWS CLI for observe and verify-cleanup. Production builds it from the DISCOVERY identity. */
  observeAws?: AwsCli;
  /** Test seam: the Azure reader's HTTP client (src/observe/azure-rest.ts). Production uses fetch against the two Azure hosts. */
  observeArm?: ArmHttp;
} & Pick<ApplyDeps, "contractPath" | "contractPinPath" | "qualificationDir" | "evidenceDir" | "nonces" | "scratchParent" | "toolDirs">;

/** Why a command ended, without parsing text: a refusal's code and outcome, or a CLI error's code. */
export type ApplyReport = { code: string; message: string; outcome?: ApplyOutcome; data?: unknown };

type Flags = { single: readonly string[]; repeated?: readonly string[]; optional?: readonly string[] };
const SUBCOMMANDS: Readonly<Record<string, Flags>> = {
  qualify: { single: ["request", "manifest"] },
  seal: { single: ["request", "manifest", "requester", "key"] },
  approve: { single: ["bundle", "key", "approver"] },
  apply: { single: ["request", "manifest", "sealed"], repeated: ["approval"] },
  status: { single: [], optional: ["sealed"] },
  pin: { single: [] },
  "contract-check": { single: ["file"] },
  preflight: { single: ["environment"], optional: ["contract"] },
  prepare: { single: ["environment", "project"], optional: ["aws-cli-version"] },
  "record-live": { single: ["sealed"] },
  "record-recovery": { single: ["sealed", "resumed", "target-hardware-id"] },
  observe: { single: ["sealed"] },
  "propose-cleanup": { single: ["sealed", "requester", "key"] },
  cleanup: { single: ["proposal", "request", "manifest", "sealed"], repeated: ["approval"] },
  "verify-cleanup": { single: ["proposal"] },
  report: { single: ["sealed"], optional: ["proposal"] },
  "preview-evidence": { single: ["sealed", "gate", "target-hardware-id"] },
};
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const CODE_PHRASE = "RUN PROJECT CODE";
/** What the person types when the contract opts in to embedding STATE_WRITE in the plan: one phrase per environment, no flag skips it. */
const embedPhrase = (environment: string): string => "EMBED STATE_WRITE " + environment;
const REQUEST_KEYS: Readonly<Record<string, readonly string[]>> = {
  seal: ["environment", "target", "projectRoot", "policyVersion", "resolved"],
  apply: ["environment", "target", "projectRoot"],
  cleanup: ["environment", "target", "projectRoot"],
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
function readRequest(sub: "seal" | "apply" | "cleanup", path: string): Record<string, unknown> & { environment: ApplyEnvironment; target: ResolvedTarget; projectRoot: string } {
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

/** The deletion unit the plan stamps, as the approvers see it: the tags verified in the plan and the created resources no tag can reach. */
const unitLines = ({ unit }: Pick<SealedPlan, "unit">): string[] => unit === null
  ? ["  deletion unit   none (this engine seals no unit tag; leftovers can be confirmed by address only)"]
  : ["  deletion unit   " + printable(unit.unitId) + " (tags " + printable(tagLine(unit.tags)) + ", verified on every created resource that carries tags)",
    ...(unit.untagged.length > 0 ? ["  untagged        " + unit.untagged.map(printable).join(", ") + " (this type carries no tags; traceable through the state only)"] : [])];

/** Which program made the preview and whether qualification evidence covers it: on every screen that shows a sealed plan. */
const provenanceLines = ({ engineVersion, provenance }: Pick<SealedPlan, "engineVersion" | "provenance">): string[] => [
  "  preview engine  version " + printable(engineVersion) + ", program sha256 " + provenance.engineBinarySha256,
  provenance.qualification.state === "QUALIFIED"
    ? "  qualified       yes: real-engine evidence " + provenance.qualification.evidenceHash.slice(0, 12) + " from " + provenance.qualification.qualifiedAt
    : "  qualified       NO: " + printable(provenance.qualification.reason),
];

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
  requester?: NonNullable<SealRequest["requester"]>,
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
    "  manifest hash   " + manifest.manifestHash, "  product commit  " + sourceCommit,
    ...(requester ? ["  requester       " + requester.requesterId + " (signs this request with their allowlisted key; every approver signs who requested)"] : []), reads(notices),
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
      ...(requester ? { requester } : {}),
    },
  };
}

/**
 * A seal is requested by a person with an allowlisted key (docs/act-pilot-plan.md, authority item 3): the id and the key
 * file are read before any phrase, the key as an approver's is read (mode 0600, Ed25519, never the environment), and the
 * driver checks the id is on the contract's allowlist and the key is that entry's own before any engine runs.
 */
const sealCommand: Command = async (flags, terminal, deps, out) => {
  const requesterId = flags.requester[0];
  if (!SAFE_OPERATOR.test(requesterId)) fail("APPLY_INPUT_INVALID", "--requester is not a usable requester id");
  const requester = { requesterId, privateKeyPem: readApproverKey(flags.key[0]) };
  const gate = await confirmProjectCode(flags, terminal, deps, out, (n) => n.sealHeading, (n) => n.sealReads, requester);
  if (typeof gate === "number") return gate;
  const result = await sealPreview(gate.request, { env: deps.env ?? process.env, now: deps.now, ...driverPaths(deps, gate.sourceCommit) });
  if (!result.ok) return blocked(result, out);
  const { sealed } = result;
  // The bundle approvers review. It holds no secret, so it can leave the operator's machine; the sealed plan itself cannot.
  const reviewBundlePath = result.path + ".review.json";
  writeFileSync(reviewBundlePath, JSON.stringify(reviewBundleOf(sealed), null, 2) + "\n", { mode: 0o600 });
  out.say(JSON.stringify({
    artifactSha256: sealed.artifactSha256, environment: sealed.environment, target: sealed.target, releaseIdentity: sealed.releaseIdentity,
    manifestHash: sealed.manifestHash, sourceCommit: sealed.sourceCommit, engineVersion: sealed.engineVersion, provenance: sealed.provenance,
    requesterId: sealed.requesterId, sealedPlanPath: result.path, reviewBundlePath, changes: sealed.changes, unit: sealed.unit,
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
  const raw = readInput(flags.bundle[0], "--bundle");
  // A cleanup proposal is approved by the same person, key and allowlist, under its own signature domain: the phrase, the review and the signature all say "cleanup".
  if (isRecord(raw) && raw.kind === "CLEANUP_PROPOSAL") return approveCleanup(raw, approverId, privateKeyPem, contract, terminal, deps, out);
  const opened = verifyReviewBundle(raw);
  if (!opened.ok) return blocked(opened, out);
  const { bundle } = opened;
  // One channel per workflow: refused before the approver is asked anything or the key is used.
  if (bundle.channel !== (deps.channel ?? "CLI")) {
    return blocked({ ok: false, code: "CHANNEL_MISMATCH", message: channelMismatchMessage(bundle.channel) }, out);
  }
  const pinned = targetForEnvironment(contract, bundle.environment, bundle.target);
  if (!pinned.ok) return blocked(pinned, out);
  // The requester's signature verifies against the allowlist before the approver is shown anything, and where the environment
  // forbids a requester-approver (PROD) this approver's id or key must not be the requester's. The driver checks both again.
  const requested = verifyRequestSignature({ request: bundle.request, artifactSha256: bundle.artifactSha256, environment: bundle.environment, requesterId: bundle.requesterId, contract });
  if (!requested.ok) return blocked(requested, out);
  if (approverIsRequester(bundle.environment, approverId, requesterPublicKey(privateKeyPem), requested)) {
    return blocked({ ok: false, code: "APPROVER_IS_REQUESTER", message: "You requested this change (" + requested.requesterId + "), so you cannot approve it in " + bundle.environment + ": the requester and the approvers must be distinct people. Nothing was signed." }, out);
  }

  const now = (deps.now ?? (() => new Date()))();
  const expiresAt = new Date(now.getTime() + contract.maxApprovalAgeMinutes * 60_000);
  const phrase = "APPROVE " + bundle.environment + " " + bundle.artifactSha256.slice(0, 12);
  terminal.write([
    "", "APPROVE AN APPLY OF THIS EXACT PLAN TO " + bundle.environment + " (your signature, valid until " + expiresAt.toISOString() + ", usable once)",
    "  artifact        " + bundle.artifactSha256, "  manifest hash   " + bundle.manifestHash,
    "  target          " + targetString(bundle.target), "  requested by    " + requested.requesterId + " (signature verified against the allowlist)", "  approver        " + approverId,
    ...provenanceLines(bundle), ...unitLines(bundle), "  changes",
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

/** The cleanup half of `approve`: the proposal is verified against its own hash, shown in full, and signed under the cleanup domain. */
async function approveCleanup(raw: unknown, approverId: string, privateKeyPem: string, contract: PilotContract, terminal: HumanTerminal, deps: ApplyCliDeps, out: Out): Promise<number> {
  const opened = verifyCleanupProposal(raw);
  if (!opened.ok) return blocked(opened, out);
  const { proposal } = opened;
  if (proposal.channel !== (deps.channel ?? "CLI")) return blocked({ ok: false, code: "CHANNEL_MISMATCH", message: channelMismatchMessage(proposal.channel) }, out);
  const pinned = targetForEnvironment(contract, proposal.environment, proposal.target);
  if (!pinned.ok) return blocked(pinned, out);
  if (proposal.contractSha256 !== pilotContractSha256(contract)) return blocked({ ok: false, code: "PROPOSAL_INVALID", message: "The proposal was made under another pilot contract." }, out);
  // The cleanup requester's signature verifies against the allowlist before the approver is shown anything, and in PROD this approver's id or key must
  // not be the requester's: the same rule and the same check as an apply (owner decision 6440801434, item 1). The driver checks both again.
  const requested = verifyRequestSignature({
    request: proposal.request, artifactSha256: proposal.proposalSha256, environment: proposal.environment, requesterId: proposal.requesterId, contract, subject: "CLEANUP_REQUEST",
  });
  if (!requested.ok) return blocked(requested, out);
  if (approverIsRequester(proposal.environment, approverId, requesterPublicKey(privateKeyPem), requested)) {
    return blocked({ ok: false, code: "APPROVER_IS_REQUESTER", message: "You requested this cleanup (" + requested.requesterId + "), so you cannot approve it in " + proposal.environment + ": the requester and the approvers must be distinct people. Nothing was signed." }, out);
  }
  const now = (deps.now ?? (() => new Date()))();
  const expiresAt = new Date(now.getTime() + contract.maxApprovalAgeMinutes * 60_000);
  const phrase = "APPROVE CLEANUP " + proposal.environment + " " + proposal.proposalSha256.slice(0, 12);
  terminal.write([
    "", "APPROVE A CLEANUP OF EXACTLY THESE RESOURCES IN " + proposal.environment + " (your signature, valid until " + expiresAt.toISOString() + ", usable once, and never valid for an apply)",
    "  target          " + targetString(proposal.target), "  approver        " + approverId, "  product commit  " + proposal.sourceCommit,
    "  requester       " + requested.requesterId + " (signature verified against the allowlist)", ...proposalLines(proposal), "",
    "The proposal's hash was recomputed here and matches. Type " + phrase + " to sign (anything else stops here):", "",
  ].join("\n"));
  await confirm(terminal, phrase, "approve> ", "APPLY_CONFIRMATION_MISMATCH", "APPROVE_CLEANUP");
  out.say(JSON.stringify(signApproval({
    schemaVersion: 1, artifactSha256: proposal.proposalSha256, environment: proposal.environment, target: proposal.target, approverId,
    issuedAt: now.toISOString(), expiresAt: expiresAt.toISOString(), nonce: randomBytes(16).toString("hex"),
  }, privateKeyPem, "CLEANUP"), null, 2) + "\n");
  return EXIT.PASS;
}

// --- observe, propose, clean up, verify ------------------------------------------------------------------------

/** Where the observe steps read and write: the ledger directory and the contract, as the driver has them. */
const observeDeps = (deps: ApplyCliDeps) => ({
  contractPath: deps.contractPath, contractPinPath: deps.contractPinPath, evidenceDir: deps.evidenceDir ?? repoPaths().evidence, env: deps.env ?? process.env,
  toolDirs: deps.toolDirs, scratchParent: deps.scratchParent, now: deps.now, aws: deps.observeAws, arm: deps.observeArm,
});

/** Read-only: the run's identifiers against the cloud, as the DISCOVERY identity sees them. Repeating it observes again; it never applies again. */
const observeCommand: Command = async (flags, _terminal, deps, out) => {
  const opened = await openSealed(flags.sealed[0]);
  if (!("sealed" in opened)) return blocked(opened, out);
  const result = await observeRun(opened.sealed.artifactSha256, observeDeps(deps));
  if (!result.ok) return blocked(result, out);
  const { record } = result;
  out.say(JSON.stringify({ label: "SYNTHETIC_UNLESS_ATTESTED_LIVE", verdict: record.verdict, inventory: record.inventory, observedAt: record.observedAt, resources: record.resources,
    missingFromState: record.missingFromState, unexpected: record.unexpected, verifierBinarySha256: record.verifierBinarySha256 }, null, 2) + "\n");
  out.report({ code: "OBSERVED", message: "Observed " + record.resources.length + " resource(s): " + record.verdict + ".", data: record });
  return EXIT.PASS;
};

/** Where a proposal is saved for review and approval: a plain file of identifiers, private to the account, named by its hash. */
const proposalPath = (deps: ApplyCliDeps, proposal: CleanupProposal): string =>
  join(deps.proposalsDir ?? join(repoPaths().root, ".runs", "apply", "cleanup"), proposal.proposalSha256.slice(0, 12) + ".cleanup-proposal.json");

/**
 * Builds the reviewable proposal from the run's records, has its requester sign it, and writes it. Runs no engine and asks no
 * phrase: a proposal authorizes nothing by itself. The requester (owner decision 6440801434, item 1) is an allowlisted id with
 * that entry's own key, checked before anything is built or written; their id is hashed into the proposal every approver signs.
 */
const proposeCleanupCommand: Command = async (flags, _terminal, deps, out) => {
  const requesterId = flags.requester[0];
  if (!SAFE_OPERATOR.test(requesterId)) fail("APPLY_INPUT_INVALID", "--requester is not a usable requester id");
  const requesterKey = readApproverKey(flags.key[0]);
  const opened = await openSealed(flags.sealed[0]);
  if (!("sealed" in opened)) return blocked(opened, out);
  const { sealed } = opened;
  if (sealed.channel !== (deps.channel ?? "CLI")) return blocked({ ok: false, code: "CHANNEL_MISMATCH", message: channelMismatchMessage(sealed.channel) }, out);
  const contract = contractFor(deps);
  if ("reason" in contract) return blocked(contractRefusal(contract), out);
  const keyRefusal = requesterKeyRefusal(contract, requesterId, requesterKey);
  if (keyRefusal) return blocked({ ...keyRefusal, message: keyRefusal.message + " No proposal was written." }, out);
  const records = await loadRunRecords(sealed.artifactSha256, deps.evidenceDir ?? repoPaths().evidence);
  if (!records.ok) return blocked(records, out);
  const built = buildCleanupProposal({
    applyEvidence: records.applyEvidence, applyEvidenceSha256: records.applyEvidenceSha256, blueprint: records.blueprint, blueprintSha256: records.blueprintSha256,
    observation: records.observation, observationSha256: records.observationSha256, changes: sealed.changes, channel: deps.channel ?? "CLI", contract,
    engineVersion: sealed.engineVersion, env: deps.env ?? process.env, now: (deps.now ?? (() => new Date()))(), requesterId,
  });
  if (!built.ok) return blocked(built, out);
  const proposal = signCleanupProposal(built.proposal, requesterKey);
  const path = proposalPath(deps, proposal);
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(proposal, null, 2) + "\n", { mode: 0o600 });
  out.say(["", "CLEANUP PROPOSED (nothing is deleted until it is approved and run)", ...proposalLines(proposal), "", "Saved (private to this account): " + path,
    "Next: each approver runs ./alz apply approve --bundle " + path + " --key THEIR_KEY.pem --approver THEIR_ID" +
      (REQUESTER_MAY_APPROVE[proposal.environment] === true ? "" : " (" + proposal.authorization.requiredApprovals + " distinct approvers, none of them the requester " + proposal.requesterId + ")") + "; then ./alz apply cleanup --proposal " + path + " ...", ""].join("\n"));
  out.report({ code: "CLEANUP_PROPOSED", message: "Proposed the deletion of " + proposal.deletes.length + " resource(s); " + proposal.excluded.length + " kept.", data: { path, proposal } });
  return EXIT.PASS;
};

/** The only place `runCleanup` is called. */
const cleanupCommand: Command = async (flags, terminal, deps, out) => {
  const request = readRequest("cleanup", flags.request[0]);
  const manifest = readManifest(flags.manifest[0]);
  const approvals = flags.approval.map((path) => {
    const value = readInput(path, "--approval");
    return isRecord(value) ? value as unknown as SignedApproval : fail("APPLY_INPUT_INVALID", "--approval must be a JSON object");
  });
  if (!manifest) return blockedManifest(out);
  const opened = verifyCleanupProposal(readInput(flags.proposal[0], "--proposal"));
  if (!opened.ok) return blocked(opened, out);
  const { proposal } = opened;
  if (proposal.channel !== (deps.channel ?? "CLI")) return blocked({ ok: false, code: "CHANNEL_MISMATCH", message: channelMismatchMessage(proposal.channel) }, out);
  // The sealed plan the cleaned-up apply ran from: the driver derives the proposal again from it and the records.
  const sealedPlan = await openSealed(flags.sealed[0]);
  if (!("sealed" in sealedPlan)) return blocked(sealedPlan, out);
  if (sealedPlan.sealed.artifactSha256 !== proposal.artifactSha256) return blocked({ ok: false, code: "PROPOSAL_INVALID", message: "The proposal is not for this sealed plan's run. Nothing was run." }, out);
  const sourceCommit = sourceCommitFor(deps);
  if (sourceCommit !== proposal.sourceCommit) {
    return blocked(sourceCommit === undefined
      ? { ok: false, code: "SOURCE_UNVERIFIED", message: "The product source commit could not be established, so nothing was run or consumed." }
      : { ok: false, code: "SOURCE_CHANGED", message: "This cleanup was proposed from product commit " + proposal.sourceCommit.slice(0, 12) + ", but " + sourceCommit.slice(0, 12) +
          " is running. Nothing was consumed. Run from that commit, or propose and approve the cleanup again." }, out);
  }
  const who = operatorId(deps);
  const phrase = "CLEANUP " + request.environment + " " + proposal.proposalSha256.slice(0, 12) + " " + targetString(request.target);
  terminal.write([
    "", "REMOVE EXACTLY THE LISTED RESOURCES FROM " + request.environment + " (this deletes real infrastructure; there is no undo here)",
    "  account         " + request.target.account, "  backend         " + request.target.backend, "  workspace       " + request.target.workspace,
    "  product commit  " + proposal.sourceCommit, "  approvals       " + approvals.map((a) => printable(String(a.statement?.approverId))).join(", ") + " (the driver verifies each signature under the cleanup domain)",
    ...proposalLines(proposal), "",
    engineNotices(deps).cleanupNote ?? "The engine first plans the destroy of exactly this list and stops, before any approval is used, if the plan would touch anything else.",
    "Type this line exactly to remove them (anything else stops here):", "  " + phrase, "",
  ].join("\n"));
  await confirm(terminal, phrase, "cleanup> ", "APPLY_CONFIRMATION_MISMATCH", "CLEANUP");
  const now = deps.now ?? (() => new Date());
  const result = await runCleanup({
    invocation: { operatorId: who, interactiveSession: true, confirmedTarget: { ...request.target }, confirmedAt: now().toISOString() },
    environment: request.environment, target: request.target, channel: deps.channel ?? "CLI", proposal, sealedPlan, manifest, projectRoot: request.projectRoot, approvals,
  }, { env: deps.env ?? process.env, now, evidenceDir: deps.evidenceDir, nonces: deps.nonces, ...driverPaths(deps, sourceCommit) });
  if (!result.ok) return blocked(result, out);
  out.say(JSON.stringify(result.evidence, null, 2) + "\n");
  out.report({ code: "CLEANED_UP", message: "The cleanup ended " + result.evidence.outcome + ". Verify leftovers next.", data: result.evidence });
  return EXIT.PASS;
};

/** Read-only: every proposed resource against the cloud, before or after the cleanup. Completion is reported only when every deletion is confirmed. */
const verifyCleanupCommand: Command = async (flags, _terminal, deps, out) => {
  const opened = verifyCleanupProposal(readInput(flags.proposal[0], "--proposal"));
  if (!opened.ok) return blocked(opened, out);
  const result = await verifyProposalLeftovers(opened.proposal, observeDeps(deps));
  if (!result.ok) return blocked(result, out);
  const { record } = result;
  out.say(JSON.stringify({ label: "SYNTHETIC_UNLESS_ATTESTED_LIVE", disposition: record.disposition, sweep: record.sweep, cleanupRan: result.cleanupRan, nextAction: record.nextAction,
    resources: record.resources, observedAt: record.observedAt }, null, 2) + "\n");
  out.report({ code: record.disposition === "COMPLETE" ? "CLEANUP_COMPLETE" : record.disposition === "KNOWN_ADDRESSES_CONFIRMED" ? "CLEANUP_KNOWN_CONFIRMED" : "CLEANUP_INCOMPLETE", message: record.nextAction, data: record });
  return EXIT.PASS;
};

/**
 * The lifecycle acceptance report (docs/observe-and-cleanup.md, "The report"): built from the run's own records, validated
 * before it is written, and labeled SYNTHETIC unless the owner's live record covers this exact apply evidence. Read-only.
 */
const reportCommand: Command = async (flags, _terminal, deps, out) => {
  const opened = await openSealed(flags.sealed[0]);
  if (!("sealed" in opened)) return blocked(opened, out);
  const { sealed } = opened;
  const contract = contractFor(deps);
  if ("reason" in contract) return blocked(contractRefusal(contract), out);
  const evidenceDir = deps.evidenceDir ?? repoPaths().evidence;
  const applied = await readAppliedEvidence(sealed.artifactSha256, evidenceDir);
  if (!applied) return blocked({ ok: false, code: "RUN_RECORD_MISSING", message: "This plan has no finished apply evidence; a report follows an apply that ran and was recorded." }, out);
  const applyEvidenceSha256 = sha256(canonicalJson(applied as never));
  let proposal: CleanupProposal | undefined;
  if (flags.proposal) {
    const verified = verifyCleanupProposal(readInput(flags.proposal[0], "--proposal"));
    if (!verified.ok) return blocked(verified, out);
    if (verified.proposal.artifactSha256 !== sealed.artifactSha256) return blocked({ ok: false, code: "PROPOSAL_INVALID", message: "The proposal is not for this sealed plan's run." }, out);
    proposal = verified.proposal;
  }
  const liveDir = deps.acceptanceDir ?? join(repoPaths().root, "config", "acceptance", "evidence");
  const report = buildLifecycleReport({
    gateId: actGateId({ provider: contract.provider, engine: contract.engine }), provider: contract.provider, engine: contract.engine, applyEvidence: applied,
    observation: await readObservationRecord(sealed.artifactSha256, applyEvidenceSha256, evidenceDir), proposal,
    cleanup: proposal ? await readCleanupEvidence(proposal.proposalSha256, evidenceDir) : undefined,
    leftovers: proposal ? await readLeftoversRecord(proposal.proposalSha256, evidenceDir) : undefined,
    live: readLiveRecord(liveDir, sealed.artifactSha256, applyEvidenceSha256), now: (deps.now ?? (() => new Date()))(),
  });
  const problems = lifecycleReportProblems(report, { sourceCommit: sealed.sourceCommit });
  if (problems.length > 0) return blocked({ ok: false, code: "EVIDENCE_REJECTED", message: "The report did not pass its own validation: " + problems.slice(0, 4).join("; ") }, out);
  const dir = deps.reportsDir ?? join(repoPaths().root, ".runs", "apply", "reports");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, sealed.artifactSha256.slice(0, 12) + "-lifecycle" + (proposal ? "-" + proposal.proposalSha256.slice(0, 12) : "") + ".json");
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  out.say(JSON.stringify({ written: path, mode: report.mode, passed: report.passed, stages: report.stages, unresolved: report.unresolved }, null, 2) + "\n");
  out.report({ code: report.passed ? "LIFECYCLE_REPORTED_PASS" : "LIFECYCLE_REPORTED_OPEN", message: report.passed ? "Every stage passed (" + report.mode + ")." : "Unresolved: " + report.unresolved.join("; "), data: { path, report } });
  return EXIT.PASS;
};

/** The owner's live record for an artifact, when `record-live` wrote one into the acceptance directory. Only a record that names this artifact is read. */
function readLiveRecord(dir: string, artifactSha256: string, evidenceSha256: string): LiveAcceptanceRecord | undefined {
  let names: string[];
  try { names = readdirSync(dir); } catch { return undefined; }
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    try {
      const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as Partial<LiveAcceptanceRecord>;
      if (record.schemaVersion === 1 && record.label === "LIVE" && record.step === "execute" && record.artifactSha256 === artifactSha256 && record.evidenceSha256 === evidenceSha256 && typeof record.attestedBy === "string") return record as LiveAcceptanceRecord;
    } catch { /* not a record */ }
  }
  return undefined;
}

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
  // And only with the engine program that made the preview (the driver checks again). Without an enabled contract the driver refuses first.
  const contract = contractFor(deps);
  const changedBinary = "reason" in contract ? undefined : engineBinaryChange(sealedPlan.sealed, engineOf(contract).binarySha256(deps.toolDirs, deps.env ?? process.env));
  if (changedBinary) return blocked(changedBinary, out);
  const who = operatorId(deps);

  // One phrase carries the environment, the artifact and the target, so what is typed is what runs.
  const phrase = "APPLY " + request.environment + " " + sealedPlan.sealed.artifactSha256.slice(0, 12) + " " + targetString(request.target);
  terminal.write([
    "", "APPLY A SEALED PLAN TO " + request.environment + " (this changes real infrastructure; there is no undo here)",
    "  account         " + request.target.account, "  backend         " + request.target.backend, "  workspace       " + request.target.workspace,
    "  artifact        " + sealedPlan.sealed.artifactSha256, "  manifest hash   " + manifest.manifestHash, "  product commit  " + sealedPlan.sealed.sourceCommit,
    "  requested by    " + printable(sealedPlan.sealed.requesterId) + " (the driver verifies the requester's signature)",
    "  approvals       " + approvals.map((a) => printable(String(a.statement?.approverId))).join(", ") + " (the driver verifies each signature)",
    ...provenanceLines(sealedPlan.sealed), ...unitLines(sealedPlan.sealed), "  changes", ...changeLines(sealedPlan.sealed),
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

// --- contract-check ----------------------------------------------------------------------------------------

/**
 * The owner-input kit (docs/act-pilot-aws-terraform-g0.md): which owner inputs a DRAFT contract still lacks, each named
 * in plain words by its field, with the contract validator's own verdict on the shape (src/apply/contract-check.ts). It
 * reads the one file named and nothing else: no pin, no identity variable, no cloud, no network. It never enables ACT
 * and never writes the pin; exit 0 says the draft is complete, exit 2 that inputs remain, and neither grants anything.
 */
const contractCheckCommand: Command = async (flags, terminal, _deps, out) => {
  const file = flags.file[0];
  const report = checkDraftContract(readInput(file, "--file"));
  terminal.write(contractCheckLines(report, file).join("\n"));
  out.say(JSON.stringify({ file, ...report }, null, 2) + "\n");
  out.report({ code: report.complete ? "CONTRACT_DRAFT_COMPLETE" : "CONTRACT_DRAFT_INCOMPLETE", message: report.complete ? "The draft carries every owner input; the owner's reviewed pin commit is the next step." : "The draft is not complete; the report names each input that remains.", data: report });
  return report.complete ? EXIT.PASS : EXIT.BLOCKED;
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

/** The command each `prepare` next step names; flags after the request and manifest are placeholders the operator fills in. */
const NEXT_COMMAND: Readonly<Record<"qualify" | "seal", { command: string; trailing: string }>> = {
  qualify: { command: "./alz apply qualify", trailing: "" },
  seal: { command: "./alz apply seal", trailing: " --requester ID --key REQUESTER_KEY.pem" },
};

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
    "  deletion unit   " + s.unit.unitId, "  required tags   " + tagLine(s.unit.tags),
    "  Your provider configuration must stamp these tags on every resource this change creates (AWS: default_tags in the provider block; Azure: tags on each resource).",
    "  Sealing checks the plan for them and refuses a missing or foreign tag; types that carry no tags are listed for the approvers.",
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
      : "NEXT " + NEXT_COMMAND[result.next.step].command + " --request " + written.request + " --manifest " + written.manifest + NEXT_COMMAND[result.next.step].trailing + "\n  " + result.next.reason + "\n"));
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

// --- record-recovery -------------------------------------------------------------------------------------

/**
 * The product-owned producer of the `act-run-recovery` release gate's evidence (src/apply/recovery-record.ts): from the ledger's
 * own evidence of an interrupted apply and of the apply that followed it under new approvals, bound to the product commit, with
 * every gate field derived and nothing typed but the attestation. A pair of runs that does not show a recovery is refused by
 * name before any phrase is asked for, and nothing is written. It starts no engine, reads no cloud and never overwrites a file.
 */
const recordRecoveryCommand: Command = async (flags, terminal, deps, out) => {
  const contract = contractFor(deps);
  if ("reason" in contract) return blocked(contractRefusal(contract), out);
  const openedInterrupted = await openSealed(flags.sealed[0]);
  if (!("sealed" in openedInterrupted)) return blocked(openedInterrupted, out);
  const openedResumed = await openSealed(flags.resumed[0]);
  if (!("sealed" in openedResumed)) return blocked(openedResumed, out);
  const hardware = flags["target-hardware-id"][0];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(hardware)) fail("APPLY_INPUT_INVALID", "--target-hardware-id must name the host these applies ran on (letters, digits, dots, dashes), as the admission manifest names it");
  const ledger = deps.evidenceDir ?? repoPaths().evidence;
  const interrupted = await readAppliedEvidence(openedInterrupted.sealed.artifactSha256, ledger);
  if (!interrupted) fail("RECOVERY_RECORD_UNAVAILABLE", "the interrupted plan has no finished apply evidence in the ledger. A record is made only from runs the ledger recorded");
  const resumed = await readAppliedEvidence(openedResumed.sealed.artifactSha256, ledger);
  if (!resumed) fail("RECOVERY_RECORD_UNAVAILABLE", "the resumed plan has no finished apply evidence in the ledger. A record is made only from runs the ledger recorded");
  const who = operatorId(deps);
  const now = (deps.now ?? (() => new Date()))();
  const common = { interrupted: interrupted!, resumed: resumed!, contract, sourceCommit: sourceCommitFor(deps), targetHardwareId: hardware, now };
  const dry = buildRecoveryEvidence({ ...common, attestedBy: who });
  if (!dry.ok) {
    out.complain("BLOCKED " + dry.code + ": " + dry.message + "\n");
    out.report({ code: dry.code, message: dry.message });
    return EXIT.BLOCKED;
  }
  const { evidence } = dry;
  const phrase = "RECOVERY LIVE " + evidence.environment + " " + evidence.interrupted.artifactSha256.slice(0, 12) + " " + evidence.resumed.artifactSha256.slice(0, 12);
  terminal.write([
    "", "RECORD ACT RUN RECOVERY EVIDENCE (" + evidence.cloud + " " + evidence.engine + ")",
    "  environment     " + evidence.environment, "  account         " + evidence.target.account, "  backend         " + evidence.target.backend, "  workspace       " + evidence.target.workspace,
    "  interrupted     " + evidence.interrupted.artifactSha256 + " ended " + evidence.interrupted.outcome + " at " + evidence.interrupted.finishedAt +
      (evidence.interrupted.recovery ? " (" + evidence.interrupted.recovery.files + " recovery file(s) kept in the vault)" : ""),
    "  resumed         " + evidence.resumed.artifactSha256 + " SUCCEEDED, " + evidence.resumed.approvals.length + " approval(s) issued after the interruption (" + evidence.requiredApprovals + " required)",
    "  product commit  " + evidence.sourceCommit,
    "", "Type this only if the interrupted apply and the one that followed both ran against the real " + evidence.cloud + " account above, not a test or a fake engine,",
    "and the interrupted run was reviewed from its ledger evidence before the new plan was sealed and approved.",
    "It is your attestation, as in record-live, and it is written into the evidence with your name:", "  " + phrase, "",
  ].join("\n"));
  await confirm(terminal, phrase, "recovery> ", "RECOVERY_ATTESTATION_MISMATCH", "ATTEST");
  const dir = deps.releaseEvidenceDir ?? join(repoPaths().root, ".runs", "release", "preview");
  const path = join(dir, evidence.gateId + "-" + evidence.interrupted.artifactSha256.slice(0, 12) + ".json");
  const bytes = JSON.stringify(evidence, null, 2) + "\n";
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("RECOVERY_RECORD_EXISTS", "evidence for this interrupted artifact is already written at " + path + "; it is never overwritten");
    throw error;
  }
  const rel = relative(repoPaths().root, path);
  const record = recoveryAdmissionRecordOf(evidence, rel.startsWith("..") || isAbsolute(rel) ? path : rel, bytes);
  out.say(JSON.stringify({ written: path, record, next: "Review the evidence, keep it with the release candidate, and add the record above to the admission manifest (node dist/cli/release-admission.js --manifest ...); the gate closes only when that review accepts it." }, null, 2) + "\n");
  out.report({ code: "RECOVERY_EVIDENCE_RECORDED", message: "Recorded ACT run recovery evidence for " + evidence.gateId + ".", data: { path, evidence, record } });
  return EXIT.PASS;
};

// --- preview-evidence ------------------------------------------------------------------------------------

/**
 * The product-owned producer of a `preview:<scenario>` release gate's evidence (src/apply/preview-evidence.ts): from a sealed
 * preview, bound to the product commit, the engine program and the plan bytes, with nothing applied. The person who ran the
 * preview attests, as in `record-live`, that it ran the pinned, qualified engine against the real target; the evidence is LIVE
 * only then and only when every other live condition holds. Typing SYNTHETIC records the same document labeled synthetic,
 * which the live gate refuses. It starts no engine, reads no cloud and never overwrites a file.
 */
const previewEvidenceCommand: Command = async (flags, terminal, deps, out) => {
  const contract = contractFor(deps);
  if ("reason" in contract) return blocked(contractRefusal(contract), out);
  const opened = await openSealed(flags.sealed[0]);
  if (!("sealed" in opened)) return blocked(opened, out);
  const { sealed } = opened;
  const gateId = flags.gate[0];
  const hardware = flags["target-hardware-id"][0];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(hardware)) fail("APPLY_INPUT_INVALID", "--target-hardware-id must name the host this preview ran on (letters, digits, dots, dashes), as the admission manifest names it");
  const now = (deps.now ?? (() => new Date()))();
  const sourceCommit = sourceCommitFor(deps);
  const engine = engineOf(contract);
  const common = { sealed, gateId, sourceCommit, targetHardwareId: hardware, engineProgramSha256Now: engine.binarySha256(deps.toolDirs, deps.env ?? process.env), contract, now };
  const dry = buildPreviewGateEvidence({ ...common, attestedBy: null });
  if (!dry.ok) {
    out.complain("BLOCKED " + dry.code + ": " + dry.message + "\n");
    out.report({ code: dry.code, message: dry.message });
    return EXIT.BLOCKED;
  }
  const who = operatorId(deps);
  const scenario = gateId.slice("preview:".length);
  const phrase = "PREVIEW LIVE " + scenario + " " + sealed.artifactSha256.slice(0, 12);
  // Every condition but the attestation is already decided; the person sees what fails before typing anything.
  const failing = dry.evidence.reasons.filter((reason) => !reason.startsWith("no person attested"));
  terminal.write([
    "", "RECORD PREVIEW GATE EVIDENCE (" + gateId + ": " + dry.evidence.provider + " " + dry.evidence.engine + ", " + dry.evidence.estate + ")",
    "  environment     " + sealed.environment, "  account         " + sealed.target.account, "  backend         " + sealed.target.backend, "  workspace       " + sealed.target.workspace,
    "  artifact        " + sealed.artifactSha256, "  plan output     sha256 " + sealed.planSha256, "  product commit  " + sealed.sourceCommit,
    ...provenanceLines(sealed),
    "  changes         " + dry.evidence.changes.total + " resource change(s): " + dry.evidence.changes.create + " created, " + dry.evidence.changes.preExistingTouched + " pre-existing touched",
    ...(failing.length > 0 ? ["", "This evidence will be SYNTHETIC whatever you type, because:", ...failing.map((reason) => "  - " + reason)] : []),
    "", "Type this only if this preview ran the pinned, qualified " + dry.evidence.engine + " against the real " + dry.evidence.provider + " target above, not a test or a fake engine.",
    "It is your attestation, as in record-live, and it is written into the evidence with your name:", "  " + phrase,
    "Type SYNTHETIC to record this as synthetic evidence instead (a fake engine, a test, a rehearsal); synthetic evidence never passes the release gate.", "",
  ].join("\n"));
  const typed = await terminal.ask("preview> ", { kind: "ATTEST", phrase });
  if (typed !== phrase && typed !== "SYNTHETIC") fail("PREVIEW_ATTESTATION_MISMATCH", "what was typed is neither the attestation above nor SYNTHETIC. Nothing was written");
  const built = buildPreviewGateEvidence({ ...common, attestedBy: typed === phrase ? who : null });
  if (!built.ok) {
    out.complain("BLOCKED " + built.code + ": " + built.message + "\n");
    out.report({ code: built.code, message: built.message });
    return EXIT.BLOCKED;
  }
  const { evidence } = built;
  const dir = deps.releaseEvidenceDir ?? join(repoPaths().root, ".runs", "release", "preview");
  const path = join(dir, gateId.replaceAll(":", "-") + "-" + sealed.artifactSha256.slice(0, 12) + ".json");
  const bytes = JSON.stringify(evidence, null, 2) + "\n";
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("PREVIEW_EVIDENCE_EXISTS", "evidence for this gate and artifact is already written at " + path + "; it is never overwritten");
    throw error;
  }
  const rel = relative(repoPaths().root, path);
  const record = admissionRecordOf(evidence, rel.startsWith("..") || isAbsolute(rel) ? path : rel, bytes);
  const live = evidence.label === "LIVE";
  out.say(JSON.stringify({
    written: path, label: evidence.label, reasons: evidence.reasons, record,
    next: live ? "Review the evidence, keep it with the release candidate, and add the record above to the admission manifest (node dist/cli/release-admission.js --manifest ...); the gate closes only when that review accepts it."
      : "Synthetic evidence: it never passes the release gate (" + evidence.reasons.length + " live condition(s) fail). Seal the preview with the pinned, qualified engine against the real target from the release commit, then record it again.",
  }, null, 2) + "\n");
  out.report({ code: live ? "PREVIEW_EVIDENCE_LIVE" : "PREVIEW_EVIDENCE_SYNTHETIC", message: live ? "Recorded LIVE preview evidence for " + gateId + "." : "Recorded SYNTHETIC preview evidence for " + gateId + "; it never passes the gate.", data: { path, evidence, record } });
  return EXIT.PASS;
};

const COMMANDS: Readonly<Record<string, Command>> = {
  qualify: qualifyCommand, seal: sealCommand, approve: approveCommand, apply: applyCommand, status: statusCommand, pin: pinCommand, "contract-check": contractCheckCommand,
  preflight: preflightCommand, prepare: prepareCommand, "record-live": recordLiveCommand, "record-recovery": recordRecoveryCommand,
  observe: observeCommand, "propose-cleanup": proposeCleanupCommand, cleanup: cleanupCommand, "verify-cleanup": verifyCleanupCommand, report: reportCommand, "preview-evidence": previewEvidenceCommand,
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
  if (["status", "approve", "pin", "contract-check", "preflight", "prepare", "record-live", "record-recovery", "observe", "propose-cleanup", "verify-cleanup", "report", "preview-evidence"].includes(sub)) return;
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
