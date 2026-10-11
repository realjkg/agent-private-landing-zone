import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promptGuide } from "../session/help.js";
import { parseRecoveryTargets } from "../recovery/target-loader.js";
import {
  explainRecoveryIntent,
  parseRecoveryTargetIntent,
  recoveryIntentFromAnswers,
  recoveryTargetStatus,
  recoveryTestReadiness,
} from "../recovery/profile/operator.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function operatorError(problem: string, recommendedFix: string, safeAlternative: string): Error {
  return new Error([
    "Problem: " + problem,
    "Recommended fix: " + recommendedFix,
    "Safe alternative: " + safeAlternative,
    "No infrastructure changes were made.",
  ].join("\n"));
}

function workspacePath(value: string): string {
  const path = resolve(root, value);
  if (path !== root && !path.startsWith(root + sep)) {
    throw operatorError(
      "path escapes the accelerator workspace.",
      "use a file path inside the repository.",
      "copy the target file into config/ and retry.",
    );
  }
  return path;
}

function readWorkspaceJson(value: string): unknown {
  const path = workspacePath(value);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw operatorError(
      "Could not read " + value + ".",
      "Use an existing JSON file inside the repository workspace.",
      "Run ./alz help to review the supported target and recovery commands.",
    );
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw operatorError(
      value + " is not valid JSON.",
      "Correct the JSON syntax and retry.",
      "Regenerate the file with ./alz target init when working with recovery intent.",
    );
  }
}

function localBin(name: string): string {
  return resolve(root, "node_modules", ".bin", process.platform === "win32" ? name + ".cmd" : name);
}

function run(command: string, args: string[], capture = false, allowNonzeroExit = false): string {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    shell: false,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });

  if (result.error || (result.status !== 0 && !allowNonzeroExit)) {
    throw new Error("Operator command failed: " + command + " " + args.join(" "));
  }

  if (result.status !== 0) {
    // A nonzero exit is a diagnosis the child already reported (e.g. `alz
    // health` finding the contract unmet): propagate it, don't wrap it.
    process.exitCode = result.status ?? 1;
  }

  return capture ? result.stdout ?? "" : "";
}

function runTs(script: string, args: string[] = [], allowNonzeroExit = false): void {
  const compiled = resolve(root, script.replace(/^src\//, "dist/").replace(/\.ts$/, ".js"));
  if (existsSync(compiled)) {
    run(process.execPath, [compiled, ...args], false, allowNonzeroExit);
    return;
  }
  run(localBin("tsx"), [resolve(root, script), ...args], false, allowNonzeroExit);
}

const PROVIDERS = ["aws", "azure"];
const ENGINES = ["terraform", "pulumi", "opentofu", "bicep", "cloudformation", "cdk", "crossplane", "ansible"];
const SCENARIOS = ["brownfield", "greenfield", "unknown"];

function choice(value: string | undefined, allowed: string[], fallback: string): string {
  const selected = (value ?? fallback).toLowerCase();
  if (!allowed.includes(selected)) {
    throw operatorError(
      "Unsupported option " + selected + ".",
      "Use one of: " + allowed.join(", ") + ".",
      "Run ./alz help to review the command syntax.",
    );
  }
  return selected;
}

async function help(): Promise<void> {
  const lines = [
    "",
    "Agent Private Landing Zone",
    "────────────────────────────────",
    "Operator commands",
    "",
    "  ./alz bootstrap",
    "  ./alz demo [aws|azure] [terraform|pulumi|opentofu|bicep|cloudformation|cdk|crossplane|ansible] [brownfield|greenfield|unknown]",
    "  ./alz design [aws|azure] [terraform|pulumi|opentofu|bicep|cloudformation|cdk|crossplane|ansible] [brownfield|greenfield|unknown]",
    "  ./alz inspect [aws|azure]",
    "  ./alz session [aws|azure] [terraform|pulumi|opentofu|bicep|cloudformation|cdk|crossplane|ansible]",
    "  ./alz debug [aws|azure] [terraform|pulumi|opentofu|bicep|cloudformation|cdk|crossplane|ansible] [brownfield|greenfield|unknown] [--fixture] [--request \"...\"]",
    "  ./alz target init <target-id> <owner> <aws|azure> <scope-id> <startup|enterprise> <development|production> <non-critical|business|critical> [--compliance=PACK@1,...]",
    "  ./alz target check <intent-file>",
    "  ./alz target explain <intent-file>",
    "  ./alz recovery status [target-file]",
    "  ./alz recovery test [target-file]",
    "  ./alz control-plane capture --root <release-root> --evidence <encrypted-bundle>",
    "  ./alz control-plane verify --evidence <encrypted-bundle>",
    "  ./alz control-plane drill --evidence <encrypted-bundle>",
    "  ./alz control-plane restore --evidence <encrypted-bundle> --restore-root <empty-isolated-path>",
    "  ./alz economics report <input.json> [--json]",
    "  ./alz teardown record|check-plan|destroy-preview|orphans (read-only)",
    "  ./alz teardown destroy-preview-run|preview-run (interactive terminal only; the console shows the command and never runs it)",
    "  ./alz health [--serve]",
    "  ./alz doctor",
    "  ./alz verify",
    "  ./alz plugins",
    "  ./alz prompts",
    "  ./alz models list",
    "  ./alz models verify [--all] [--model MODEL]",
    "  ./alz sbom",
    "  ./alz scan",
    "  ./alz matrix --offline-fixture [--scenario ID]",
    "  ./alz matrix --live-models [--scenario ID]",
    "  ./alz chaos",
  ];
  // One line per catalog command group; the catalog loads only when needed.
  const { groupHelpLines } = await import("../operations/groups.js");
  lines.push(...groupHelpLines(), "", "ACT remains disabled. inspect/session use read-only provider access.", "");
  for (const line of lines) console.log(line);
}

/** Security, plugin and toolbox self-checks shared by `doctor` and `verify`. */
function doctor(): void {
  runTs("src/cli/security.ts");
  runTs("src/cli/plugins.ts");
  runTs("src/cli/toolbox.ts");
}

function verify(): void {
  console.log("Verifying code, policy boundaries, compatibility, and core scenarios...");

  const sourceQualification =
    existsSync(localBin("tsx")) && existsSync(localBin("tsc")) && existsSync(resolve(root, "test"));

  if (sourceQualification) {
    run(localBin("tsc"), ["-p", "tsconfig.json", "--noEmit"]);
    const tests = readdirSync(resolve(root, "test"))
      .filter((name) => name.endsWith(".test.ts"))
      .sort()
      .map((name) => resolve(root, "test", name));
    run(localBin("tsx"), ["--test", ...tests]);
  } else {
    console.log(
      "Packaged runtime detected; source type-check and test-suite qualification were completed at release build time.",
    );
  }

  doctor();

  for (const [provider, scenario] of [["aws", "brownfield"], ["azure", "brownfield"], ["azure", "greenfield"], ["aws", "unknown"]]) {
    runTs("src/cli/discover.ts", ["--provider", provider, "--mock", scenario]);
  }

  run("npm", ["audit", "--omit=dev", "--audit-level=high"]);

  console.log();
  console.log("✓ operator verification complete");
}

function sbom(): void {
  const directory = resolve(root, ".runs", "sbom");
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  const output = run("npm", ["sbom", "--sbom-format=cyclonedx", "--package-lock-only"], true);
  const path = resolve(directory, "agent-private-landing-zone.cdx.json");
  writeFileSync(path, output, { encoding: "utf8", mode: 0o600 });
  console.log("SBOM written to " + path);
}

function scan(): void {
  run("npm", ["audit", "--audit-level=high"]);

  const trivy = spawnSync("trivy", ["--version"], { encoding: "utf8", shell: false, stdio: "ignore" });
  if (trivy.status !== 0) {
    console.log(
      "Trivy is not installed locally; dependency audit passed. CI performs the full filesystem/misconfiguration scan.",
    );
    return;
  }

  run("trivy", ["fs", "--scanners", "vuln,misconfig", "--severity", "HIGH,CRITICAL", "--exit-code", "1", root]);
}

function target(first: string | undefined, second: string | undefined, argv: string[]): void {
  if (first === "init") {
    const complianceFlag = argv.slice(9).find((value) => value.startsWith("--compliance="));
    const compliancePacks = complianceFlag
      ? complianceFlag.slice("--compliance=".length).split(",").filter(Boolean)
      : [];
    const intent = recoveryIntentFromAnswers(argv.slice(2, 9), compliancePacks);
    const directory = resolve(root, "config", "recovery-intents");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = resolve(directory, intent.targetId + ".json");
    writeFileSync(path, JSON.stringify(intent, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    console.log("Target intent saved: " + path);
    console.log("No infrastructure changes were made.");
  } else if (first === "check" || first === "explain") {
    if (!second) {
      throw operatorError(
        "an intent file is required.",
        "provide a JSON file created by ./alz target init.",
        "run ./alz target init to create one.",
      );
    }
    const intent = parseRecoveryTargetIntent(readWorkspaceJson(second));
    if (first === "check") {
      console.log("Target intent is valid.");
      console.log(
        "Ready for deterministic compilation when approved design and provider-edge destination evidence are available.",
      );
    } else {
      console.log();
      console.log(explainRecoveryIntent(intent));
      console.log();
    }
    console.log("No infrastructure changes were made.");
  } else {
    throw operatorError(
      "unknown target command.",
      "use target init, target check, or target explain.",
      "run ./alz help.",
    );
  }
}

function recovery(first: string | undefined, second: string | undefined): void {
  if (first !== "status" && first !== "test") {
    throw operatorError(
      "unknown recovery command.",
      "use recovery status or recovery test.",
      "use the conversational recovery workflow for explanation.",
    );
  }

  const targets = parseRecoveryTargets(
    readWorkspaceJson(second ?? process.env.AGENTIC_RECOVERY_TARGETS_FILE ?? "config/recovery-targets.json"),
  );

  let blockedTest = false;
  for (const item of targets) {
    const result = first === "status" ? recoveryTargetStatus(item) : recoveryTestReadiness(item);
    console.log();
    console.log(result.lines.join("\n"));
    if (first === "test" && !result.ready) blockedTest = true;
  }
  if (blockedTest) process.exitCode = 1;
}

const argv = process.argv.slice(2);
const [command = "help", first, second, third] = argv;

try {
  if (command === "help" || command === "--help" || command === "-h") {
    await help();
  } else if (command === "demo" || command === "design") {
    runTs("src/demo.ts", [
      "--provider", choice(first, PROVIDERS, "aws"),
      "--engine", choice(second, ENGINES, "terraform"),
      "--scenario", choice(third, SCENARIOS, "brownfield"),
    ]);
  } else if (command === "workspace") {
    runTs("src/cli/operator-web.ts");
  } else if (command === "matrix") {
    runTs("src/cli/private-agent-matrix.ts", argv.slice(1));
  } else if (command === "chaos") {
    runTs("src/cli/chaos-pillars.ts", argv.slice(1));
  } else if (command === "teardown") {
    // Read-only verdicts; exit 2 (BLOCKED / orphans) is a diagnosis to propagate.
    runTs("src/cli/teardown.ts", argv.slice(1), true);
  } else if (command === "inspect") {
    runTs("src/cli/discover.ts", ["--provider", choice(first, PROVIDERS, "aws"), "--resources"]);
  } else if (command === "session") {
    runTs("src/cli/session.ts", [
      "--provider", choice(first, PROVIDERS, "aws"),
      "--engine", choice(second, ENGINES, "terraform"),
    ]);
  } else if (command === "debug") {
    runTs("src/cli/debug.ts", [
      "--provider", choice(first, PROVIDERS, "aws"),
      "--engine", choice(second, ENGINES, "terraform"),
      "--mock", choice(third, SCENARIOS, "brownfield"),
      ...argv.slice(4),
    ]);
  } else if (command === "target") {
    target(first, second, argv);
  } else if (command === "recovery") {
    recovery(first, second);
  } else if (command === "control-plane") {
    runTs("src/cli/control-plane-recovery.ts", argv.slice(1));
  } else if (command === "economics") {
    runTs("src/cli/economics.ts", argv.slice(1));
  } else if (command === "health") {
    runTs("src/cli/health.ts", argv.slice(1), true);
  } else if (command === "doctor") {
    doctor();
  } else if (command === "verify") {
    verify();
  } else if (command === "plugins") {
    runTs("src/cli/plugins.ts");
  } else if (command === "prompts" || command === "prompt-guide") {
    console.log();
    console.log(promptGuide());
  } else if (command === "models") {
    runTs("src/cli/models.ts", [first, second, third].filter((value): value is string => Boolean(value)));
  } else if (command === "sbom") {
    sbom();
  } else if (command === "scan") {
    scan();
  } else {
    // Catalog command groups (./alz <group> <subcommand>) for capabilities
    // with no legacy branch above.
    const { resolveGroupCommand } = await import("../operations/groups.js");
    const resolved = resolveGroupCommand(command, argv.slice(1));
    if (resolved === null) {
      await help();
      process.exitCode = 2;
    } else if (resolved.kind === "run") {
      // A catalog report may exit 2 for a diagnosis (checked and rejected): propagate it, as teardown and health do.
      runTs(resolved.script, resolved.args, true);
    } else if (resolved.kind === "list") {
      console.log(["", ...resolved.lines, ""].join("\n"));
    } else {
      throw operatorError(
        "unknown " + command + " subcommand " + String(first) + ".",
        "Use one of the subcommands listed below.",
        "Run ./alz " + command + " list.\n" + resolved.lines.join("\n"),
      );
    }
  }
} catch (error) {
  console.error();
  console.error(error instanceof Error ? error.message : "Operator command failed.");
  process.exitCode = 1;
}
