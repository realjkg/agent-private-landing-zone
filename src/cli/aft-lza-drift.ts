import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { AwsCliReader, assertNoAmbientKeys, type AwsExec } from "../aft-lza/aws-reader.js";
import { DRIFT_EXIT, collectDrift, driftMarkdown, driftReport, type DriftReaders } from "../aft-lza/drift.js";
import { GitHubReader } from "../aft-lza/github-reader.js";
import { loadCard } from "../evidence-runner/aft-lza.js";

/**
 * `./alz qualify aft-lza-drift --card config/<card>.json --output .runs/qualification/aft-lza-drift.json [--summary .runs/<file>.md]`
 *
 * Read-only drift detection for the AFT/LZA pilot (src/aft-lza/drift.ts). AWS reads use a federated identity
 * (AWS_ROLE_ARN + AWS_WEB_IDENTITY_TOKEN_FILE in GitHub Actions, or an AWS_PROFILE SSO session on the owner's machine);
 * static keys are refused. GitHub reads use AFT_LZA_GITHUB_TOKEN when set. Exit 0 in sync, 3 drifted, 2 unknown, 1 error.
 */
export type DriftCliDeps = {
  root: string;
  env: NodeJS.ProcessEnv;
  now: () => string;
  /** Builds the readers; production uses the aws CLI and the GitHub REST API. */
  readers: (env: NodeJS.ProcessEnv) => DriftReaders;
  log: (line: string) => void;
  error: (line: string) => void;
};

const inside = (root: string, path: string, folder: string): string => {
  const full = resolve(root, path);
  const rel = relative(resolve(root, folder), full);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(sep) || resolve(rel) === rel) throw new Error("AFT_LZA_DRIFT_PATH: " + path + " must be under " + folder + "/");
  return full;
};

export function productionReaders(env: NodeJS.ProcessEnv): DriftReaders {
  const child = { ...env };
  delete child.AFT_LZA_GITHUB_TOKEN;
  delete child.GITHUB_TOKEN;
  delete child.GH_TOKEN;
  const exec: AwsExec = (args) => new Promise((done) => execFile("aws", args, { env: child, maxBuffer: 32 * 1024 * 1024, shell: false }, (error, stdout, stderr) =>
    done({ code: error ? 1 : 0, stdout, stderr })));
  return { aws: new AwsCliReader(exec), github: new GitHubReader(env.AFT_LZA_GITHUB_TOKEN) };
}

export async function runDriftCli(argv: readonly string[], deps: DriftCliDeps): Promise<number> {
  const arg = (name: string): string | undefined => { const i = argv.indexOf("--" + name); return i >= 0 ? argv[i + 1] : undefined; };
  const cardPath = arg("card"), output = arg("output"), summary = arg("summary");
  if (!cardPath || !output) { deps.error("Usage: ./alz qualify aft-lza-drift --card config/<card>.json --output .runs/qualification/aft-lza-drift.json [--summary .runs/<file>.md]"); return 1; }
  try {
    assertNoAmbientKeys(deps.env);
    const outFile = inside(deps.root, output, ".runs");
    const summaryFile = summary ? inside(deps.root, summary, ".runs") : undefined;
    if (!(deps.env.AWS_ROLE_ARN && deps.env.AWS_WEB_IDENTITY_TOKEN_FILE) && !deps.env.AWS_PROFILE) {
      deps.error("AFT_LZA_DRIFT_IDENTITY: set AWS_ROLE_ARN and AWS_WEB_IDENTITY_TOKEN_FILE (GitHub OIDC) or AWS_PROFILE (SSO) for a read-only role.");
      return 2;
    }
    const loaded = loadCard(deps.root, cardPath);
    if (!loaded.ok) { deps.error("AFT_LZA_CARD: " + loaded.detail); return 2; }
    const report = driftReport(loaded.card, await collectDrift(loaded.card, deps.readers(deps.env)), deps.now(), "LIVE_READ_ONLY");
    mkdirSync(dirname(outFile), { recursive: true, mode: 0o700 });
    writeFileSync(outFile, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    if (summaryFile) { mkdirSync(dirname(summaryFile), { recursive: true, mode: 0o700 }); writeFileSync(summaryFile, driftMarkdown(report), { mode: 0o600 }); }
    deps.log("AFT/LZA drift: " + report.verdict + " (" + report.counts.DRIFTED + " drifted, " + report.counts.UNKNOWN + " unknown). Report: " + output);
    return DRIFT_EXIT[report.verdict];
  } catch (error) {
    deps.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runDriftCli(process.argv.slice(2), {
    root: process.cwd(), env: process.env, now: () => new Date().toISOString(), readers: productionReaders,
    log: (line) => console.log(line), error: (line) => console.error(line),
  }).then((code) => { process.exitCode = code; });
}
