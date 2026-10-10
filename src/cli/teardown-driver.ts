import { createInterface } from "node:readline";
import { readFileSync, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { resolve } from "node:path";

import { verifyManifest, type ArtifactManifest } from "../teardown/manifest.js";
import {
  DRIVER_ENGINES,
  assertNoRawPayload,
  runCleanups,
  sweepStale,
  runDestroyPreview,
  runPreview,
  type DriverDeps,
  type DriverResult,
  type EngineAdapter,
  type PreviewRequest,
  type QualificationRecord,
  type ResolvedTarget,
} from "../teardown/driver/index.js";
import { createPulumiAdapter } from "../teardown/driver/adapters/pulumi.js";
import { createTerraformAdapter } from "../teardown/driver/adapters/terraform.js";
import type { DeletionUnit } from "../teardown/types.js";

// The human entry to the destroy-preview driver (docs/destroy-preview-driver.md).
// The operator authorizes the preview, the driver enforces the contract, and no
// preview capability grants authority to change infrastructure. This module is
// human-invoked only: it is not a broker tool and nothing under src/tools,
// src/agent or src/operator-ui imports it. ACT stays DISABLED.

export const DRIVER_COMMANDS = ["destroy-preview-run", "preview-run"] as const;
export type DriverCommand = typeof DRIVER_COMMANDS[number];

/** 0 PASS. 1 error: bad input, no human at a terminal, wrong confirmation, adapter or evidence failure. 2 BLOCKED. */
export const EXIT = { PASS: 0, ERROR: 1, BLOCKED: 2 } as const;

export const DRIVER_USAGE = [
  "  ./alz teardown destroy-preview-run|preview-run --request REQUEST.json --manifest MANIFEST.json",
  "      --unit UNIT.json --qualifications QUALIFICATIONS.json",
  "                                             human-invoked, preview-only; needs a terminal and prints",
  "                                             redacted evidence JSON. Identities come from ALZ_DISCOVERY_*",
  "                                             and ALZ_STATE_* only. Exit 0 PASS, 2 BLOCKED, 1 error.",
  "  No other flag exists: nothing forces, skips, ignores, overrides or pre-answers anything.",
].join("\n");

/**
 * The person at the keyboard. TEST-ONLY SEAM: `runDriverCommand`'s `terminal`
 * parameter lets a test supply a fake so no TTY is needed. Nothing on the
 * command line, in the environment or in a file can reach it, so no operator
 * can use it to skip the prompt. The default is the real process terminal.
 */
export type HumanTerminal = {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  write(text: string): void;
  /** Shows the question and returns the one line the person typed. */
  ask(question: string): Promise<string>;
};

export function processTerminal(): HumanTerminal {
  return {
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    write: (text) => { process.stdout.write(text); },
    ask: (question) => new Promise((done) => {
      const lines = createInterface({ input: process.stdin, output: process.stdout });
      let answered = false;
      lines.question(question, (answer) => { answered = true; lines.close(); done(answer); });
      lines.on("close", () => { if (!answered) done(""); });
    }),
  };
}

export type DriverCliDeps = {
  /** TEST-ONLY SEAM, see HumanTerminal. */
  terminal?: HumanTerminal;
  /** Defaults to the three engine adapters. An engine runs only with a matching qualification record. */
  adapters?: readonly EngineAdapter[];
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  scratchParent?: string;
  /** Defaults to the operating-system account name. */
  operatorId?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
};

const FLAGS = ["request", "manifest", "unit", "qualifications"] as const;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const SAFE_OPERATOR = /^[A-Za-z0-9._@+-]{1,128}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// The CLI supplies these itself. A file that carries them could claim a human, a manifest, a unit or an approval.
// Capabilities are granted by what the person confirms at the prompts, never by a field in a file.
const SUPPLIED_BY_CLI = ["invocation", "manifest", "unit", "capabilities"];
const CODE_PHRASE = "RUN PROJECT CODE";
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const SIGNAL_NUMBER: Readonly<Record<typeof SIGNALS[number], number>> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

/**
 * Plan files, the work copy and the snapshot are removed from the signal
 * handlers too, since a `finally` block does not run on a signal. The engine
 * runs under a blocking spawnSync, so a signal sent to this process alone is
 * handled when the current engine step ends (docs/destroy-preview-driver.md, Limits).
 */
export function installSignalCleanup(): () => void {
  const handlers = SIGNALS.map((signal) => {
    const handler = () => { runCleanups(); process.exit(128 + SIGNAL_NUMBER[signal]); };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  return () => { for (const [signal, handler] of handlers) process.off(signal, handler); };
}

class CliError extends Error {}
const fail = (code: string, detail = ""): never => { throw new CliError(code + (detail ? ": " + detail : "")); };
const shown = (value: string): string => JSON.stringify(value.length > 40 ? value.slice(0, 40) + "..." : value);

/** Exactly --request --manifest --unit --qualifications, each once. Everything else is refused, whatever it is called. */
function parseFlags(args: string[]): Record<typeof FLAGS[number], string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const name = flag?.startsWith("--") ? flag.slice(2) : undefined;
    if (name === undefined || !(FLAGS as readonly string[]).includes(name)) {
      fail("TEARDOWN_FLAG_UNKNOWN", shown(flag ?? "") + ". This command takes only --" + FLAGS.join(", --") +
        "; there is no flag that forces, skips, ignores, overrides or pre-answers anything");
    }
    const value = args[index + 1];
    if (value === undefined || value === "" || value.startsWith("--")) fail("TEARDOWN_ARGUMENT_INVALID", "--" + name);
    if (values.has(name!)) fail("TEARDOWN_ARGUMENT_INVALID", "--" + name + " given twice");
    values.set(name!, value);
  }
  for (const name of FLAGS) if (!values.has(name)) fail("TEARDOWN_ARGUMENT_REQUIRED", "--" + name);
  return Object.fromEntries(values) as Record<typeof FLAGS[number], string>;
}

/** Parse errors are fixed text: a JSON error can quote the file, and these files describe a real environment. */
function readInput(path: string, label: string): unknown {
  try {
    const size = statSync(path).size;
    if (size > MAX_INPUT_BYTES) fail("TEARDOWN_INPUT_INVALID", label + " is larger than " + MAX_INPUT_BYTES + " bytes");
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof CliError) throw error;
    return fail("TEARDOWN_INPUT_INVALID", label + " cannot be read as a JSON file");
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function resolvedTarget(value: unknown): ResolvedTarget {
  const fields = ["account", "backend", "workspace"] as const;
  if (!isRecord(value) || fields.some((key) => typeof value[key] !== "string" || value[key] === "" ||
    (value[key] as string).length > 512 || CONTROL.test(value[key] as string))) {
    fail("TEARDOWN_INPUT_INVALID", "request.target needs a printable account, backend and workspace");
  }
  const target = value as ResolvedTarget;
  return { account: target.account, backend: target.backend, workspace: target.workspace };
}

/** The one string the operator must type. Account, backend, then workspace or stack. */
export const targetString = (target: ResolvedTarget): string =>
  [target.account, target.backend, target.workspace].join(" | ");

/** Only evidence reaches stdout. A refusal's code and fixed message go to stderr. */
function report(result: DriverResult, say: (text: string) => void, complain: (text: string) => void): number {
  if (!result.ok) {
    complain("BLOCKED " + result.code + (result.fields?.length ? " (" + result.fields.join(", ") + ")" : "") +
      ": " + result.message + "\n");
    // A driver or evidence failure is an error, not a decision; every other refusal is the contract saying no.
    return result.code === "ADAPTER_FAILED" || result.code === "EVIDENCE_REJECTED" ? EXIT.ERROR : EXIT.BLOCKED;
  }
  try {
    assertNoRawPayload(result.evidence);
  } catch {
    complain("The evidence was withheld because it did not pass the redaction check.\n");
    return EXIT.ERROR;
  }
  say(JSON.stringify(result.evidence, null, 2) + "\n");
  return result.evidence.verdict === "BLOCKED" ? EXIT.BLOCKED : EXIT.PASS;
}

export async function runDriverCommand(
  command: DriverCommand,
  args: string[],
  deps: DriverCliDeps = {},
): Promise<number> {
  const say = deps.stdout ?? ((text: string) => { process.stdout.write(text); });
  const complain = deps.stderr ?? ((text: string) => { process.stderr.write(text); });
  try {
    const flags = parseFlags(args);

    // A person at a terminal, on input and output. There is no flag, file or variable that waives this.
    const terminal = deps.terminal ?? processTerminal();
    if (!terminal.stdinIsTTY || !terminal.stdoutIsTTY) {
      fail("HUMAN_TERMINAL_REQUIRED", "a preview is started by a person at an interactive terminal (stdin and stdout). " +
        "Nothing was read or run, and there is no way to bypass this");
    }

    const file = readInput(flags.request, "--request");
    if (!isRecord(file)) fail("TEARDOWN_INPUT_INVALID", "--request is not a JSON object");
    const supplied = SUPPLIED_BY_CLI.filter((key) => key in (file as Record<string, unknown>));
    if (supplied.length > 0) {
      fail("TEARDOWN_INPUT_INVALID", "--request must not carry " + supplied.join(", ") +
        ": the command supplies them (the invocation from the prompt, the manifest and unit from their own files)");
    }
    const requestFile = file as Record<string, unknown>;
    const engine = requestFile.engine;
    if (typeof engine !== "string" || !(DRIVER_ENGINES as readonly string[]).includes(engine)) {
      fail("TEARDOWN_INPUT_INVALID", "request.engine must be one of " + DRIVER_ENGINES.join(", "));
    }
    if (requestFile.mode !== "PROJECT" && requestFile.mode !== "STATE_DERIVED") {
      fail("TEARDOWN_INPUT_INVALID", "request.mode must be PROJECT or STATE_DERIVED");
    }
    const target = resolvedTarget(requestFile.target);
    if (typeof requestFile.projectRoot !== "string" || requestFile.projectRoot === "") {
      fail("TEARDOWN_INPUT_INVALID", "request.projectRoot is required");
    }

    const unit = readInput(flags.unit, "--unit") as DeletionUnit;
    const qualifications = readInput(flags.qualifications, "--qualifications");
    if (!Array.isArray(qualifications)) fail("TEARDOWN_INPUT_INVALID", "--qualifications must be a JSON array of records");
    let manifest: ArtifactManifest;
    try {
      manifest = verifyManifest(readInput(flags.manifest, "--manifest"));
    } catch (error) {
      if (error instanceof CliError) throw error;
      complain("BLOCKED MANIFEST_INVALID: The manifest is not valid or not sealed.\n");
      return EXIT.BLOCKED;
    }

    const operatorId = deps.operatorId ?? userInfo().username;
    if (!SAFE_OPERATOR.test(operatorId)) fail("TEARDOWN_INPUT_INVALID", "the operator account name is not usable as an operator id");

    // The operator sees what will be previewed and types the exact target. A mismatch ends it.
    const expected = targetString(target);
    const operation = command === "destroy-preview-run" ? "DESTROY PREVIEW" : "PREVIEW";
    terminal.write([
      "",
      operation + " (preview only: this changes no infrastructure and cannot apply or destroy anything)",
      "  account         " + target.account,
      "  backend         " + target.backend,
      "  workspace/stack " + target.workspace,
      "  engine          " + engine + " (" + requestFile.mode + ")",
      "  manifest hash   " + manifest.manifestHash,
      "  reads           cloud state and resources, with the read-only STATE and DISCOVERY identities",
      "",
      "Type the target exactly to continue (anything else stops here):",
      "  " + expected,
      "",
    ].join("\n"));
    const typed = await terminal.ask("target> ");
    if (typed !== expected) {
      fail("HUMAN_CONFIRMATION_MISMATCH", "the typed target is not the target above. Nothing was run");
    }

    // Running project code is its own approval, given here by the person and never read from a file.
    let projectCodeExecution = false;
    if (requestFile.mode === "PROJECT") {
      terminal.write([
        "",
        "THIS PREVIEW RUNS PROJECT CODE (providers, modules and the program) with the DISCOVERY identity.",
        "It changes no infrastructure and this approval never permits that, but the code runs on this machine.",
        "  project root    " + resolve(requestFile.projectRoot as string),
        "  files bound     " + manifest.files.length,
        "",
        "Type " + CODE_PHRASE + " to allow it (anything else stops here):",
        "",
      ].join("\n"));
      if ((await terminal.ask("code> ")) !== CODE_PHRASE) {
        fail("PROJECT_CODE_CONFIRMATION_MISMATCH", "project code was not approved. Nothing was run");
      }
      projectCodeExecution = true;
    }

    const now = deps.now ?? (() => new Date());
    const request = {
      ...requestFile,
      capabilities: { cloudRead: true, projectCodeExecution },
      target,
      projectRoot: resolve(requestFile.projectRoot as string),
      invocation: {
        operatorId, interactiveSession: true as const,
        confirmedTarget: { ...target }, confirmedAt: now().toISOString(),
      },
      manifest,
      unit,
    } as unknown as PreviewRequest;
    const driverDeps: DriverDeps = {
      adapters: deps.adapters ?? [
        createTerraformAdapter("TERRAFORM"), createTerraformAdapter("OPENTOFU"), createPulumiAdapter(),
      ],
      qualifications: qualifications as QualificationRecord[],
      env: deps.env ?? process.env,
      now,
      ...(deps.scratchParent ? { scratchParent: deps.scratchParent } : {}),
    };
    const removeHandlers = installSignalCleanup();
    try {
      sweepStale(deps.scratchParent ?? tmpdir());
      const result = command === "destroy-preview-run" ? runDestroyPreview(request, driverDeps) : runPreview(request, driverDeps);
      return report(result, say, complain);
    } finally {
      removeHandlers();
    }
  } catch (error) {
    // Only messages this module wrote. Anything else is reported by name, never by text.
    complain((error instanceof CliError ? error.message : "TEARDOWN_UNEXPECTED_ERROR") + "\n");
    return EXIT.ERROR;
  }
}
