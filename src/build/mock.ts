import type { EnvironmentState, Provider } from "../discovery/types.js";
import { sha256 } from "./provenance.js";
import type {
  IaCEngine,
  ScannerResult,
} from "./types.js";

export type MockGeneratedArtifact = {
  path: string;
  content: string;
};

export function generateMockArtifact(
  provider: Provider,
  engine: IaCEngine,
): MockGeneratedArtifact {
  if (
    engine === "TERRAFORM" ||
    engine === "OPENTOFU"
  ) {
    return {
      path: "generated/main.tf",
      content: [
        "# PREVIEW-ONLY FIXTURE",
        `# Provider: ${provider}`,
        "# No cloud resources are created by this fixture.",
        "",
        "terraform {",
        engine === "OPENTOFU"
          ? '  required_version = ">= 1.10.0"'
          : '  required_version = ">= 1.6.0"',
        "}",
        "",
      ].join("\n"),
    };
  }

  if (engine === "BICEP") {
    return {
      path: "generated/main.bicep",
      content: [
        "// PREVIEW-ONLY FIXTURE",
        `// Provider: ${provider}`,
        "targetScope = 'resourceGroup'",
        "",
      ].join("\n"),
    };
  }

  if (engine === "CLOUDFORMATION") {
    return {
      path: "generated/template.json",
      content: JSON.stringify(
        {
          AWSTemplateFormatVersion:
            "2010-09-09",
          Description:
            "PREVIEW-ONLY FIXTURE",
          Resources: {},
        },
        null,
        2,
      ),
    };
  }

  return {
    path: "generated/index.ts",
    content: [
      "// PREVIEW-ONLY FIXTURE",
      `// Provider: ${provider}`,
      "// No cloud resources are created by this fixture.",
      "",
      'export const mode = "preview-only";',
      "",
    ].join("\n"),
  };
}

export function runMockScanners(
  content: string,
): ScannerResult[] {
  const scannerPayload = JSON.stringify({
    syntax: "passed",
    policy: "passed",
    contentHash: sha256(content),
  });

  return [
    {
      scanner: "fixture-syntax",
      version: "1",
      passed: true,
      findings: [],
      evidenceHash: sha256(scannerPayload),
    },
    {
      scanner: "fixture-policy",
      version: "1",
      passed: true,
      findings: [],
      evidenceHash: sha256(
        `policy:${sha256(content)}`,
      ),
    },
  ];
}

export function createMockPreview(
  environment: EnvironmentState,
  engine: IaCEngine,
  artifactHash: string,
): {
  summary: string;
  hash: string;
} {
  const summary = [
    "PREVIEW ONLY",
    `provider=${environment.provider}`,
    `classification=${environment.classification}`,
    `safeBuildMode=${environment.safeBuildMode}`,
    `engine=${engine}`,
    `artifactHash=${artifactHash}`,
    "create=0",
    "update=0",
    "delete=0",
  ].join("\n");

  return {
    summary,
    hash: sha256(summary),
  };
}
