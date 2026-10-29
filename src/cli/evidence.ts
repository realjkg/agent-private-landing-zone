import { hostname } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DEFAULT_CONFIG_PATH } from "../evidence-runner/config.js";
import { federatedProbe } from "../evidence-runner/identity.js";
import { evidenceInit, evidenceRun, evidenceStatus, type RunnerDeps, type RunOptions, type Terminal } from "../evidence-runner/run.js";
import { changedPathsOf, gitReader, sourceCommitOf } from "../evidence-runner/source.js";
import { EXIT, STAGES, type StageId } from "../evidence-runner/types.js";

/**
 * `./alz evidence init | run | status` (docs/evidence-runner.md): the owner's local live-evidence runner.
 *
 * A HANDOFF in the operation catalog: the console shows the command and never runs it. No flag carries a credential,
 * pre-answers the attestation or a product phrase, forces or skips a check; the only inputs are the configuration path, one
 * stage name and the dry-run and synthetic switches.
 */
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const USAGE = [
  "Usage:",
  "  ./alz evidence init [--config FILE]",
  "  ./alz evidence run [--config FILE] [--stage " + STAGES.join("|") + "] [--dry-run] [--synthetic]",
  "  ./alz evidence status [--config FILE] [--synthetic]",
].join("\n");

type Parsed = { sub: "init" | "run" | "status"; options: RunOptions } | { error: string };

export function parseEvidenceArgs(argv: readonly string[]): Parsed {
  const [sub, ...rest] = argv;
  if (sub !== "init" && sub !== "run" && sub !== "status") return { error: "Unknown or missing subcommand." };
  const options: RunOptions = { configPath: DEFAULT_CONFIG_PATH, dryRun: false, synthetic: false };
  const allowed: Record<typeof sub, readonly string[]> = {
    init: ["--config"], run: ["--config", "--stage", "--dry-run", "--synthetic"], status: ["--config", "--synthetic"],
  };
  const seen = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (!allowed[sub].includes(flag)) return { error: "Unknown option for " + sub + "." };
    if (seen.has(flag)) return { error: flag + " was given twice." };
    seen.add(flag);
    if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--synthetic") options.synthetic = true;
    else {
      const value = rest[index + 1];
      index += 1;
      if (value === undefined || value.startsWith("-")) return { error: flag + " needs a value." };
      if (flag === "--config") options.configPath = value;
      else if ((STAGES as readonly string[]).includes(value)) options.stage = value as StageId;
      else return { error: "--stage must be one of " + STAGES.join(", ") + "." };
    }
  }
  return { sub, options };
}

function processTerminal(): Terminal {
  return {
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    ask: (question) => new Promise((done) => {
      const lines = createInterface({ input: process.stdin, output: process.stdout });
      let answered = false;
      lines.question(question, (answer) => { answered = true; lines.close(); done(answer); });
      lines.on("close", () => { if (!answered) done(""); });
    }),
  };
}

export async function runEvidenceCommand(argv: readonly string[], overrides: Partial<RunnerDeps> = {}): Promise<number> {
  const base = overrides.root ?? root;
  const env = overrides.env ?? process.env;
  const git = gitReader(base, env);
  const deps: RunnerDeps = {
    root, env: process.env, terminal: processTerminal(), host: hostname(), now: () => new Date(), probe: federatedProbe(env),
    source: () => sourceCommitOf(base, git, env), changedPaths: (from, to) => changedPathsOf(git, from, to), out: (line) => console.log(line),
    ...overrides,
  };
  const parsed = parseEvidenceArgs(argv);
  if ("error" in parsed) { deps.out(parsed.error); deps.out(USAGE); return EXIT.BLOCKED; }
  if (parsed.sub === "init") return evidenceInit(parsed.options, deps);
  if (parsed.sub === "status") return evidenceStatus(parsed.options, deps);
  return evidenceRun(parsed.options, deps);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runEvidenceCommand(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => {
    console.error(error instanceof Error ? error.message : "The evidence runner failed.");
    process.exitCode = EXIT.ERROR;
  });
}
