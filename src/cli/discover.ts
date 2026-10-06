import { discoverEnvironment } from "../discovery/discover.js";
import type {
  MockScenario,
  Provider,
} from "../discovery/types.js";

function readArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function parseProvider(value?: string): Provider {
  if (value?.toLowerCase() === "aws") return "AWS";
  if (value?.toLowerCase() === "azure") return "AZURE";
  throw new Error("PROVIDER_UNAVAILABLE: use --provider aws or --provider azure");
}

function parseMock(value?: string): MockScenario | undefined {
  if (!value) return undefined;
  if (
    value === "brownfield" ||
    value === "greenfield" ||
    value === "unknown"
  ) {
    return value;
  }

  throw new Error(
    "Invalid --mock value. Use brownfield, greenfield, or unknown.",
  );
}

const provider = parseProvider(readArg("--provider"));
const mock = parseMock(readArg("--mock"));
const verbose = hasFlag("--verbose");

console.log();
console.log("Agentic Landing Zone");
console.log("────────────────────────────────");
console.log();
console.log(`Discovering ${provider} environment...`);
console.log();

try {
  const result = await discoverEnvironment(
    { provider, mock },
    (event, detail) => {
      if (verbose) {
        console.log(`› ${event.padEnd(24)} ${detail ?? ""}`);
      }
    },
  );

  console.log(`✓ Provider        ${result.provider}`);
  console.log(`✓ Classification  ${result.classification}`);
  console.log(`✓ Control plane   ${result.controlPlane}`);
  console.log(`✓ Resources       ${result.resources.length} discovered`);
  console.log(
    `✓ Ownership       ${result.ownershipSummary.readOnly} read-only / ${result.ownershipSummary.additiveOnly} additive`,
  );
  console.log(`✓ Conflicts       ${result.conflicts.length}`);
  console.log();
  console.log("Safe build mode");
  console.log(`  ${result.safeBuildMode}`);
  console.log();

  for (const warning of result.warnings) {
    console.log(`! ${warning}`);
  }

  console.log("No changes were made.");

  if (verbose) {
    console.log();
    console.log("────────────────────────────────");
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error();
  console.error("DISCOVERY FAILED");
  console.error(
    error instanceof Error ? error.message : "Unknown discovery error",
  );
  process.exitCode = 1;
}
