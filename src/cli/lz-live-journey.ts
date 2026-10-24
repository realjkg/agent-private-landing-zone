import { assertCleanSource, evidenceDir, headCommit } from "../util/cli-support.js";
import { runLzLiveJourney, type JourneyEngine } from "../qualification/lz-live-journey.js";

const HELP = [
  "Sovereign ALZ — live private-model AWS journey (PREVIEW ONLY)",
  "Run from a clean committed checkout with local Ollama and approved short-lived AWS DISCOVERY identity:",
  "node dist/cli/lz-live-journey.js --instruction 'Design a governed AWS landing zone preview' \\",
  "  --engine terraform --account <12_DIGIT_DEV_ACCOUNT> --region us-east-2 \\",
  "  --workspace <REVIEWED_PROJECT_DIRECTORY> --allow-project-code",
  "For CDK use --engine cdk --stack <EXISTING_STACK> --allow-preview-write as well.",
  "Terraform requires a prepared provider lock/backend and runs plan -refresh=false (not apply).",
  "CDK synthesis executes reviewed application code; its UPDATE Change Set is created and deleted.",
  "Explicit preview-write is required and must be granted only to a narrowly scoped preview identity.",
  "Models never receive credentials, execute tools, authorize ACT or sign approvals.",
  "Result remains REVIEW_REQUIRED; ACT DISABLED; release HOLD.",
].join("\n");

function parseArgs(args: string[]): {
  instruction: string; engine: JourneyEngine; expectedAccount: string; region: string;
  workspace: string; stack?: string; allowProjectCodeExecution: boolean; allowPreviewWrite: boolean;
} {
  const switches = new Set(["--allow-project-code", "--allow-preview-write"]);
  const values = new Set(["--instruction", "--engine", "--account", "--region", "--workspace", "--stack"]);
  const supplied = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!;
    if (switches.has(key)) {
      if (flags.has(key)) throw new Error("DUPLICATE_OPTION:" + key);
      flags.add(key);
    } else if (values.has(key)) {
      if (supplied.has(key) || !args[index + 1] || args[index + 1]!.startsWith("--")) {
        throw new Error("INVALID_OPTION:" + key);
      }
      supplied.set(key, args[++index]!);
    } else throw new Error("UNKNOWN_OPTION:" + key);
  }
  const required = (key: string): string => {
    const value = supplied.get(key);
    if (!value) throw new Error("MISSING_OPTION:" + key);
    return value;
  };
  const raw = required("--engine");
  if (!["terraform", "cdk"].includes(raw)) throw new Error("ENGINE_NOT_SUPPORTED");
  return {
    instruction: required("--instruction"),
    engine: raw === "cdk" ? "AWS_CDK" : "TERRAFORM",
    expectedAccount: required("--account"), region: required("--region"),
    workspace: required("--workspace"),
    ...(supplied.has("--stack") ? { stack: supplied.get("--stack") } : {}),
    allowProjectCodeExecution: flags.has("--allow-project-code"),
    allowPreviewWrite: flags.has("--allow-preview-write"),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("--help")) {
    console.log(HELP);
    if (!args.includes("--help")) process.exitCode = 2;
    return;
  }
  const opts = parseArgs(args);
  assertCleanSource();
  const report = await runLzLiveJourney({
    ...opts, sourceCommit: headCommit(),
    outputRoot: evidenceDir("qualification", "lz-live-journey"),
  });
  console.log("LZ live journey: " + report.status);
  console.log("Source: " + report.sourceCommit);
  console.log("Stages: " + report.stages.map((s) => s.stage + "=" + s.status).join(", "));
  console.log("Inventory: " + report.inventory.length + " observed resources");
  console.log("Engine preview: " + (report.provenance.nativePlanHash ? "NATIVE EVIDENCE RECORDED" : "NOT VERIFIED"));
  console.log("JSON evidence: " + report.evidencePath);
  console.log("Local visualization: " + report.visualizationPath);
  console.log("ACT DISABLED / AUTHORIZATION NOT_GRANTED / RELEASE HOLD");
  if (report.status !== "REVIEW_REQUIRED") process.exitCode = 2;
}
main().catch((error) => {
  const message = error instanceof Error ? error.message.split(":")[0] : "UNKNOWN_FAILURE";
  console.error("LZ_JOURNEY_BLOCKED: " + (/^[A-Z0-9_]+$/.test(message) ? message : "UNEXPECTED_ERROR"));
  console.error("ACT DISABLED / NO INFRASTRUCTURE APPLY");
  process.exitCode = 2;
});
