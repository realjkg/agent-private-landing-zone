import { readFile } from "node:fs/promises";
import {
  isAbsolute,
  relative,
  resolve,
} from "node:path";
import { discoverEnvironment } from "../discovery/discover.js";
import { createConfiguredBus } from "../observability/bus.js";
import { loadObservabilityConfig } from "../config.js";
import {
  assessEnvironment,
} from "../assessment/posture.js";
import {
  formatAssessmentSummary,
  writeAssessmentRun,
} from "../assessment/output.js";
import {
  writeConfigurationRecoverySnapshot,
} from "../assessment/recovery.js";
import {
  parseSbomDocument,
} from "../assessment/sbom.js";
import {
  parseInventoryEvidenceBundle,
  parsePostureEvidenceBundle,
} from "../assessment/ingest.js";
import {
  summarizeOwnership,
} from "../discovery/ownership.js";
import {
  formatResourceRows,
  writeDiscoveryRun,
} from "../discovery/output.js";
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

  throw new Error(
    "PROVIDER_UNAVAILABLE: use --provider aws or --provider azure",
  );
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
const showResources = hasFlag("--resources") || verbose;
const sbomPath = readArg("--sbom");
const postureEvidencePath =
  readArg("--posture-evidence");
const inventoryEvidencePath =
  readArg("--inventory-evidence");

async function readWorkspaceEvidence(
  path: string,
): Promise<string> {
  const root = resolve(process.cwd());
  const target = resolve(root, path);
  const relation = relative(
    root,
    target,
  );

  if (
    relation.startsWith("..") ||
    isAbsolute(relation)
  ) {
    throw new Error(
      "EVIDENCE_PATH_BLOCKED: evidence files must be inside the current workspace.",
    );
  }

  return readFile(target, "utf8");
}

console.log();
console.log("Agent Private Landing Zone");
console.log("────────────────────────────────");
console.log();
console.log(`Discovering ${provider} environment...`);
console.log();

const bus = createConfiguredBus(loadObservabilityConfig());

try {
  let result = await discoverEnvironment(
    { provider, mock, emitter: bus },
    (event, detail) => {
      if (verbose) {
        console.log(`› ${event.padEnd(24)} ${detail ?? ""}`);
      }
    },
  );

  if (inventoryEvidencePath) {
    const importedAssets =
      parseInventoryEvidenceBundle(
        await readWorkspaceEvidence(
          inventoryEvidencePath,
        ),
        provider,
      );

    const resources = [
      ...result.resources,
      ...importedAssets,
    ];

    result = {
      ...result,
      resources,
      ownershipSummary:
        summarizeOwnership(
          resources,
        ),
      warnings: [
        ...result.warnings,
        "IMPORTED_INVENTORY_READ_ONLY: attached asset evidence cannot grant update/delete authority.",
      ],
    };
  }

  if (sbomPath) {
    const parsedSbom =
      parseSbomDocument(
        await readWorkspaceEvidence(
          sbomPath,
        ),
        "file:" + sbomPath,
      );

    result = {
      ...result,
      sbomComponents: [
        ...result.sbomComponents,
        ...parsedSbom.components,
      ],
      sbomComplete: true,
    };
  }

  if (postureEvidencePath) {
    const bundle =
      parsePostureEvidenceBundle(
        await readWorkspaceEvidence(
          postureEvidencePath,
        ),
      );

    result = {
      ...result,
      scannerObservations: [
        ...result.scannerObservations,
        ...bundle.scannerObservations,
      ],
      resiliencyObservations: [
        ...result.resiliencyObservations,
        ...bundle.resiliencyObservations,
      ],
    };
  }

  const assessment =
    assessEnvironment(result);

  const [
    runRecord,
    assessmentRecord,
    recoveryRecord,
  ] = await Promise.all([
    writeDiscoveryRun(result, bus),
    writeAssessmentRun(assessment, bus),
    writeConfigurationRecoverySnapshot(
      assessment.recoverySnapshot,
      bus,
    ),
  ]);

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

  for (const line of formatAssessmentSummary(assessment)) {
    console.log(line);
  }
  console.log();

  if (assessment.findings.length > 0) {
    console.log("Posture findings");
    for (const finding of assessment.findings) {
      console.log(
        "  " +
          finding.severity.padEnd(8) +
          finding.domain.padEnd(14) +
          finding.title,
      );
    }
    console.log();
  }

  if (showResources) {
    console.log("Resources");
    for (const line of formatResourceRows(result.resources)) {
      console.log(line);
    }
    console.log();
  }

  for (const warning of result.warnings) {
    console.log(`! ${warning}`);
  }

  console.log("No changes were made.");
  console.log(`Discovery record  ${runRecord}`);
  console.log(`Assessment record ${assessmentRecord}`);
  console.log(`Recovery snapshot ${recoveryRecord}`);

  if (verbose) {
    console.log();
    console.log("────────────────────────────────");
    console.log("Normalized environment record");
    console.log();
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error();
  console.error("DISCOVERY FAILED");
  console.error(
    error instanceof Error
      ? error.message
      : "Unknown discovery error",
  );

  process.exitCode = 1;
}
