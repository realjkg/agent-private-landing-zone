import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import { AwsCliReader, assertNoAmbientKeys, type AwsExec } from "../aft-lza/aws-reader.js";
import { DRIFT_EXIT, collectDrift, driftMarkdown, driftReport } from "../aft-lza/drift.js";
import { GitHubReader } from "../aft-lza/github-reader.js";
import { loadCard } from "../evidence-runner/aft-lza.js";

/**
 * `./alz qualify aft-lza-drift --card config/<card>.json --output .runs/qualification/aft-lza-drift.json [--summary .runs/<file>.md]`
 *
 * Read-only drift detection for the AFT/LZA pilot (src/aft-lza/drift.ts). AWS reads use a federated identity
 * (AWS_ROLE_ARN + AWS_WEB_IDENTITY_TOKEN_FILE in GitHub Actions, or an AWS_PROFILE SSO session on the owner's machine);
 * static keys are refused. GitHub reads use AFT_LZA_GITHUB_TOKEN when set. Exit 0 in sync, 3 drifted, 2 unknown, 1 error.
 */
const arg = (name: string): string | undefined => { const i = process.argv.indexOf("--" + name); return i >= 0 ? process.argv[i + 1] : undefined; };
const inside = (root: string, path: string, folder: string): string => {
  const full = resolve(root, path);
  const rel = relative(resolve(root, folder), full);
  if (rel.startsWith("..") || rel.startsWith(sep) || rel === "") throw new Error(path + " must be under " + folder + "/");
  return full;
};

async function main(): Promise<number> {
  const root = process.cwd();
  const cardPath = arg("card"), output = arg("output"), summary = arg("summary");
  if (!cardPath || !output) { console.error("Usage: ./alz qualify aft-lza-drift --card config/<card>.json --output .runs/qualification/aft-lza-drift.json [--summary <file>]"); return 1; }
  assertNoAmbientKeys(process.env);
  if (!(process.env.AWS_ROLE_ARN && process.env.AWS_WEB_IDENTITY_TOKEN_FILE) && !process.env.AWS_PROFILE) {
    console.error("AFT_LZA_DRIFT_IDENTITY: set AWS_ROLE_ARN and AWS_WEB_IDENTITY_TOKEN_FILE (GitHub OIDC) or AWS_PROFILE (SSO) for a read-only role.");
    return 2;
  }
  const loaded = loadCard(root, cardPath);
  if (!loaded.ok) { console.error("AFT_LZA_CARD: " + loaded.detail); return 2; }
  const env = { ...process.env };
  delete env.AFT_LZA_GITHUB_TOKEN;
  delete env.GITHUB_TOKEN;
  const exec: AwsExec = (args) => new Promise((done) => execFile("aws", args, { env, maxBuffer: 32 * 1024 * 1024, shell: false }, (error, stdout, stderr) =>
    done({ code: error ? 1 : 0, stdout, stderr })));
  const aws = new AwsCliReader(exec);
  const github = new GitHubReader(process.env.AFT_LZA_GITHUB_TOKEN);
  const report = driftReport(loaded.card, await collectDrift(loaded.card, { aws, github }), new Date().toISOString(), "LIVE_READ_ONLY");
  const file = inside(root, output, ".runs");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  const markdown = driftMarkdown(report);
  if (summary) writeFileSync(inside(root, summary, ".runs"), markdown, { mode: 0o600 });
  console.log("AFT/LZA drift: " + report.verdict + " (" + report.counts.DRIFTED + " drifted, " + report.counts.UNKNOWN + " unknown). Report: " + output);
  return DRIFT_EXIT[report.verdict];
}

main().then((code) => { process.exitCode = code; }, (error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
