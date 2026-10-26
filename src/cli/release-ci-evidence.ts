import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildCiGateEvidence, ciAdmissionRecordOf, readArtifactFiles, type ExportedRunFacts } from "../release/ci-evidence.js";
import { CI_ARTIFACT_NAME, CI_GATES } from "../qualification/ci-gate.js";
import { loadReleaseScope } from "../release/status.js";
import { EXIT, processTerminal, type HumanTerminal } from "./teardown-driver.js";

/**
 * `node dist/cli/release-ci-evidence.js --gate source-ci|release-archive --run RUN_ID --artifacts DIR`
 *
 * The product-owned producer of a CI release gate's evidence (src/release/ci-evidence.ts; the contract in
 * src/qualification/ci-gate.ts). It reads only files in DIR, which the person exported and downloaded beforehand:
 *
 *   gh api repos/OWNER/REPO/actions/runs/RUN_ID            > DIR/run.json
 *   gh api repos/OWNER/REPO/actions/runs/RUN_ID/jobs       > DIR/jobs.json
 *   gh api repos/OWNER/REPO/actions/runs/RUN_ID/artifacts  > DIR/artifacts.json
 *   gh run download RUN_ID --name agent-private-landing-zone-supply-chain --dir DIR
 *
 * Nothing here reads a token or opens a connection. The run must be of the frozen candidate commit (config/release/scope.json)
 * and must show every step the gate rests on succeeded; otherwise it is refused by name before the phrase is asked for and
 * nothing is written. The person then types the attestation, and the evidence is written once to .runs/release/ci/.
 */
export type CiEvidenceCliDeps = {
  root?: string;
  terminal?: HumanTerminal;
  operatorId?: string;
  now?: () => Date;
  /** Where the evidence is written; defaults to `.runs/release/ci` under the root. */
  releaseEvidenceDir?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
};

const USAGE = "node dist/cli/release-ci-evidence.js --gate " + Object.keys(CI_GATES).join("|") + " --run RUN_ID --artifacts DIR";
const FLAGS = ["--gate", "--run", "--artifacts"] as const;

function readJson(dir: string, name: string): unknown {
  try {
    return JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export async function releaseCiEvidence(args: string[], deps: CiEvidenceCliDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((text: string) => { process.stdout.write(text); });
  const err = deps.stderr ?? ((text: string) => { process.stderr.write(text); });
  const blocked = (code: string, message: string): number => { err("BLOCKED " + code + ": " + message + "\n"); return EXIT.BLOCKED; };
  const invalid = (code: string, message: string): number => { err(code + ": " + message + "\n"); return EXIT.ERROR; };
  if (args.length === 1 && args[0] === "--help") { out(USAGE + "\n"); return EXIT.PASS; }
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!(FLAGS as readonly string[]).includes(flag ?? "") || value === undefined || value.startsWith("-") || values.has(flag!)) return invalid("CI_EVIDENCE_ARGUMENT_INVALID", USAGE);
    values.set(flag!, value);
  }
  if (values.size !== FLAGS.length) return invalid("CI_EVIDENCE_ARGUMENT_REQUIRED", USAGE);
  const gateId = values.get("--gate")!;
  const runText = values.get("--run")!;
  if (!/^[1-9][0-9]{0,18}$/.test(runText)) return invalid("CI_EVIDENCE_ARGUMENT_INVALID", "--run must be the GitHub Actions run id, a positive integer");
  const runId = Number(runText);
  const root = deps.root ?? process.cwd();
  const dir = resolve(root, values.get("--artifacts")!);
  const facts: ExportedRunFacts = { run: readJson(dir, "run.json"), jobs: readJson(dir, "jobs.json"), artifacts: readJson(dir, "artifacts.json") };
  for (const [name, value] of Object.entries(facts)) if (value === undefined) return blocked("RUN_FACTS_UNREADABLE", name + ".json is missing from " + dir + " or is not JSON. Export it with gh api (see --help). Nothing was written.");
  let candidate: string | null;
  try {
    candidate = loadReleaseScope(root).candidate;
  } catch (error) {
    return blocked("RELEASE_SCOPE_INVALID", (error as Error).message + " Nothing was written.");
  }
  const who = deps.operatorId ?? process.env.USER ?? process.env.USERNAME ?? "";
  if (who.trim() === "") return invalid("CI_EVIDENCE_OPERATOR_UNKNOWN", "no operator name: set USER or pass one through the deps");
  const now = (deps.now ?? (() => new Date()))();
  const built = buildCiGateEvidence({ gateId, runId, facts, files: readArtifactFiles(dir), candidate, attestedBy: who, now });
  if (!built.ok) return blocked(built.code, built.message);
  const { evidence } = built;
  const terminal = deps.terminal ?? processTerminal();
  const phrase = "CI LIVE " + evidence.gateId + " " + evidence.sourceCommit.slice(0, 12) + " " + evidence.run.id;
  terminal.write([
    "", "RECORD CI GATE EVIDENCE (" + evidence.gateId + ": " + CI_GATES[evidence.gateId].why + ")",
    "  candidate       " + evidence.sourceCommit, "  run             " + evidence.run.htmlUrl + " (attempt " + evidence.run.attempt + ", " + evidence.run.event + ", " + evidence.run.conclusion + ")",
    "  job             " + evidence.run.job.name + " on " + evidence.run.runner.name + (evidence.run.runner.labels.length > 0 ? " [" + evidence.run.runner.labels.join(", ") + "]" : ""),
    "  steps           " + CI_GATES[evidence.gateId].steps.join("; "),
    ...(evidence.files.length > 0 ? ["  files           " + evidence.files.map((file) => file.name + " sha256 " + file.sha256.slice(0, 12)).join(", ")] : []),
    ...(evidence.releaseManifest ? ["  release manifest for " + evidence.releaseManifest.sourceCommit + ", version " + evidence.releaseManifest.productVersion] : []),
    "", "Type this only if you exported run.json, jobs.json and artifacts.json yourself from GitHub for this run, and downloaded the " + CI_ARTIFACT_NAME + " artifact from it, unedited.",
    "It is your attestation, written into the evidence with your name:", "  " + phrase, "",
  ].join("\n"));
  const typed = await terminal.ask("ci> ", { kind: "ATTEST", phrase });
  if (typed !== phrase) return invalid("CI_ATTESTATION_MISMATCH", "what was typed is not the attestation above. Nothing was written");
  const evidenceDir = deps.releaseEvidenceDir ?? join(root, ".runs", "release", "ci");
  const path = join(evidenceDir, evidence.gateId + "-" + evidence.sourceCommit.slice(0, 12) + ".json");
  const bytes = JSON.stringify(evidence, null, 2) + "\n";
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return invalid("CI_EVIDENCE_EXISTS", "evidence for this gate and candidate is already written at " + path + "; it is never overwritten");
    throw error;
  }
  const rel = relative(root, path);
  const record = ciAdmissionRecordOf(evidence, rel.startsWith("..") || isAbsolute(rel) ? path : rel, bytes);
  out(JSON.stringify({ written: path, record, next: "Review the evidence, keep it with the release candidate, and add the record above to the admission manifest (node dist/cli/release-admission.js --manifest ...); the gate closes only when that review accepts it." }, null, 2) + "\n");
  return EXIT.PASS;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  releaseCiEvidence(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => { process.stderr.write("CI_EVIDENCE_FAILED: " + String((error as Error)?.message ?? error).slice(0, 160) + "\n"); process.exitCode = EXIT.ERROR; });
}
