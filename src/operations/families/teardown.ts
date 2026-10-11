import type { Field, OperationSpec, Values } from "../types.js";

// Teardown review family (docs/teardown-traceability.md). The four reviews read
// pasted JSON and print a verdict: no engine runs, no cloud is called, nothing
// is deleted. The destroy-preview driver needs a person at a terminal who types
// the exact target (docs/teardown-broker-review.md, Decision 1), so the console
// only shows its command and reads back the redacted evidence it wrote.

const ENGINES = ["TERRAFORM", "OPENTOFU", "PULUMI", "CLOUDFORMATION", "AWS_CDK", "BICEP"];
const READ = "READ-ONLY REVIEW OF PASTED JSON — NO ENGINE, NO CLOUD ACCESS, NOTHING DELETED";
const DRIVER = "REDACTED PREVIEW EVIDENCE — PREVIEW ONLY, ACT DISABLED";
const PLAN_HELP = "Output of your own engine run, such as terraform show -json. The console never runs the engine.";

const json = (name: string, label: string, help?: string, optional?: boolean): Field =>
  ({ kind: "json", name, label, maxBytes: 64 * 1024, ...(help ? { help } : {}), ...(optional ? { optional } : {}) });
const unit = (name = "unit", label = "Deletion unit"): Field => json(name, label, "A unit recorded by teardown record.");
const path = (name: string, label: string, example: string): Field =>
  ({ kind: "text", name, label, maxLength: 120, pattern: "[A-Za-z0-9_./-]+", example,
    help: "Only fills in the command below. The console never opens this file." });
const flags = (v: Values, ...pairs: [string, string][]): string[] =>
  pairs.flatMap(([name, flag]) => (v[name] ? ["--" + flag, String(v[name])] : []));

const review = (id: string, sub: string, rest: Pick<OperationSpec, "title" | "summary" | "inputs" | "job" | "cliScript">): OperationSpec =>
  ({ id, family: "teardown", cli: "./alz teardown " + sub, safety: "READ_ONLY", evidenceBasis: READ, ...rest });

const driverHandoff = (id: string, sub: string, title: string, summary: string, destroy: boolean): OperationSpec => ({
  id, title, summary, family: "teardown", cli: "./alz teardown " + sub, safety: "HANDOFF", evidenceBasis: DRIVER,
  cliScript: "src/cli/teardown-driver.ts",
  inputs: [path("request", "Request file", "REQUEST.json"), path("manifest", "Manifest file", "MANIFEST.json"),
    path("unit", "Deletion unit file", "UNIT.json"), path("qualifications", "Qualification records file", "QUALIFICATIONS.json")],
  handoff: {
    reason: "A person at an interactive terminal types the exact target before anything runs, so the console cannot start it. " +
      "Set two separate read-only identities with the ALZ_DISCOVERY_ and ALZ_STATE_ prefixes. " +
      "An engine runs only with a matching qualification record in the qualifications file. " +
      (destroy ? "It previews a destroy and never performs one." : "It previews a create and never applies it.") +
      " Exit 0 means PASS, 2 BLOCKED, 1 error.",
    command: "./alz teardown " + sub + " --request {request} --manifest {manifest} --unit {unit} --qualifications {qualifications}",
    env: ["ALZ_DISCOVERY_AWS_ACCESS_KEY_ID", "ALZ_DISCOVERY_AWS_SECRET_ACCESS_KEY", "ALZ_DISCOVERY_AZURE_CONFIG_DIR",
      "ALZ_STATE_AWS_ACCESS_KEY_ID", "ALZ_STATE_AWS_SECRET_ACCESS_KEY", "ALZ_STATE_AZURE_CONFIG_DIR"],
    viewer: "teardown-evidence",
  },
});

export const teardownOperations: readonly OperationSpec[] = [
  review("teardown-record", "record", {
    title: "Record a deletion unit",
    summary: "Records the resources a build will create, from its create plan, as a deletion unit for later review.",
    inputs: [
      { kind: "text", name: "buildId", label: "Build ID", maxLength: 63, pattern: "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", example: "build-0b7e4c1a" },
      { kind: "enum", name: "provider", label: "Provider", options: ["AWS", "AZURE"] },
      { kind: "enum", name: "engine", label: "Engine of the create plan", options: ENGINES },
      json("state", "State reference", "Where the build keeps its state, for example engine, backend, location and workspace."),
      { kind: "text", name: "designHash", label: "Design hash", maxLength: 64, pattern: "[a-f0-9]{64}", example: "d".repeat(64), help: "SHA-256 of the approved design." },
      json("plan", "Create plan", PLAN_HELP),
      { kind: "text", name: "expires", label: "Expires", optional: true, maxLength: 10, pattern: "\\d{4}-\\d{2}-\\d{2}", example: "2027-01-31", help: "Optional date, YYYY-MM-DD." },
    ],
    job: { script: "cli/teardown.js", args: (v) => ["record", "--build-id", String(v.buildId), "--provider", String(v.provider),
      "--engine", String(v.engine), "--state", String(v.state), "--design-hash", String(v.designHash), "--plan", String(v.plan), ...flags(v, ["expires", "expires"])] },
  }),
  review("teardown-check-plan", "check-plan", {
    title: "Check a create plan",
    summary: "Checks that a create plan makes exactly the resources in the deletion unit and tags every one of them.",
    inputs: [unit(), json("plan", "Create plan", PLAN_HELP), { kind: "text", name: "untaggableTypes", label: "Untaggable types", optional: true, maxLength: 200,
      pattern: "[A-Za-z0-9_.:/,-]+", example: "aws:ec2/vpc:Vpc,AWS::IAM::Role", help: "Optional reviewed list of resource types that cannot carry tags, separated by commas." }],
    job: { script: "cli/teardown.js", args: (v) => ["check-plan", "--unit", String(v.unit), "--plan", String(v.plan), ...flags(v, ["untaggableTypes", "untaggable-types"])] },
  }),
  review("teardown-destroy-preview", "destroy-preview", {
    title: "Evaluate a destroy plan",
    summary: "Checks that a destroy plan removes only what the deletion unit created. It evaluates a plan you supply and runs nothing.",
    inputs: [unit(), json("plan", "Destroy plan", PLAN_HELP)],
    cliScript: "src/cli/teardown-review.ts",
    job: { script: "cli/teardown-review.js", args: (v) => ["verdict", "--unit", String(v.unit), "--plan", String(v.plan)] },
  }),
  review("teardown-orphans", "orphans", {
    title: "Find orphaned resources",
    summary: "Lists tagged resources in an inventory that none of the supplied deletion units accounts for.",
    inputs: [unit(), { ...unit("otherUnit", "Second deletion unit"), optional: true },
      { kind: "enum", name: "source", label: "Inventory format", options: ["resources", "aws-tagged", "azure-tagged"],
        help: "resources is a list of discovered resources; the others are aws resourcegroupstaggingapi get-resources or az resource list output." },
      json("inventory", "Inventory")],
    job: { script: "cli/teardown.js", args: (v) => ["orphans", "--units", [v.unit, v.otherUnit].filter(Boolean).join(","), "--" + String(v.source), String(v.inventory)] },
  }),
  driverHandoff("teardown-destroy-preview-run", "destroy-preview-run", "Run a destroy preview",
    "Runs the engine to preview a destroy against your own state, at a terminal where you type the target.", true),
  driverHandoff("teardown-preview-run", "preview-run", "Run a create preview",
    "Runs the engine to preview a create against your own state, at a terminal where you type the target.", false),
  {
    id: "teardown-evidence", title: "View preview evidence", family: "teardown", cli: "npx tsx src/cli/teardown-review.ts evidence",
    safety: "READ_ONLY", evidenceBasis: DRIVER,
    summary: "Validates and shows the redacted evidence the preview driver wrote; raw plan or state output is rejected.",
    inputs: [json("evidence", "Preview evidence", "The JSON the driver printed. Never paste a plan or state document.")],
    job: { script: "cli/teardown-review.js", args: (v) => ["evidence", "--evidence", String(v.evidence)] },
  },
];
