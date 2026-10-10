import {
  createHash,
} from "node:crypto";

import type {
  EnvironmentState,
  Provider,
} from "../discovery/types.js";
import type {
  ProductionIdentityQualification,
} from "./identity.js";
import type {
  ToolResult,
} from "../tools/types.js";

export type ProviderProductionQualification = {
  schemaVersion: 1;
  sourceCommit: string;
  provider: Provider;
  ready: boolean;
  identityMode?: string;
  discovery: {
    classification: string;
    controlPlane: string;
    resourceCount: number;
    evidenceKeys: string[];
    evidenceSources: string[];
    snapshotSha256: string;
  };
  validation: {
    passed: boolean;
    tools: string[];
  };
  preview: {
    tool: string;
    commandClass:
      | "AWS_CHANGE_SET_PREVIEW"
      | "AZURE_WHAT_IF";
    durationMs: number;
    outputSha256: string;
  };
  actEnabled: false;
  blockers: string[];
};

function sha256(
  value: string,
): string {
  return createHash("sha256")
    .update(value)
    .digest("hex");
}

function validCommit(
  value: string,
): boolean {
  return /^[0-9a-f]{40}$/.test(
    value,
  );
}

function mockObserved(
  environment: EnvironmentState,
): boolean {
  return (
    environment.evidence.some(
      (item) =>
        item.source === "mock",
    ) ||
    environment.resources.some(
      (resource) =>
        resource.metadata?.mock ===
        true,
    ) ||
    environment.scannerObservations.some(
      (item) =>
        item.source === "mock",
    ) ||
    environment.resiliencyObservations.some(
      (item) =>
        item.source === "mock",
    )
  );
}

/**
 * Words that mean a command mutates, or is a destroy-mode run, not a preview.
 * Matched against each argument with leading dashes and any `=value` removed,
 * so the flag forms count too: `terraform plan -destroy` and
 * `pulumi preview --destroy` pass `-destroy` / `--destroy`, which an exact
 * match on the word `destroy` never saw. `auto-approve` and `yes` are the
 * flags that skip the confirmation a mutating command would otherwise stop at.
 */
const PROHIBITED_PREVIEW_WORDS: ReadonlySet<string> = new Set([
  "apply",
  "destroy",
  "up",
  "deploy",
  "execute-change-set",
  "create-stack",
  "update-stack",
  "delete-stack",
  "auto-approve",
  "yes",
]);

export function dangerousPreviewCommand(
  result: ToolResult,
): boolean {
  return (
    result.command?.some((part) =>
      PROHIBITED_PREVIEW_WORDS.has(
        part.toLowerCase()
          .replace(/^-+/, "")
          .split("=")[0],
      ),
    ) ?? false
  );
}

function expectedIdentity(
  provider: Provider,
): {
  key: string;
  source: string;
} {
  return provider === "AWS"
    ? {
        key: "aws.identity",
        source: "aws-cli",
      }
    : {
        key: "azure.identity",
        source: "azure-cli",
      };
}

function expectedPreviewTool(
  provider: Provider,
): ToolResult["tool"] {
  return provider === "AWS"
    ? "cloudformation_preview"
    : "bicep_what_if";
}

function commandClass(
  provider: Provider,
):
  | "AWS_CHANGE_SET_PREVIEW"
  | "AZURE_WHAT_IF" {
  return provider === "AWS"
    ? "AWS_CHANGE_SET_PREVIEW"
    : "AZURE_WHAT_IF";
}

export function qualifyProviderProduction(input: {
  sourceCommit: string;
  provider: Provider;
  identity:
    ProductionIdentityQualification;
  environment: EnvironmentState;
  validationResults: ToolResult[];
  preview: ToolResult;
  actEnabled: false;
}): ProviderProductionQualification {
  const blockers: string[] = [];

  if (
    !validCommit(
      input.sourceCommit,
    )
  ) {
    blockers.push(
      "Provider qualification is not bound to a valid source commit.",
    );
  }

  if (
    input.environment.provider !==
    input.provider
  ) {
    blockers.push(
      "Discovery provider does not match the qualification provider.",
    );
  }

  if (!input.identity.ready) {
    blockers.push(
      ...input.identity.blockers,
    );
  }

  const identityEvidence =
    expectedIdentity(
      input.provider,
    );

  if (
    !input.environment.evidence.some(
      (item) =>
        item.key ===
          identityEvidence.key &&
        item.value ===
          "authenticated" &&
        item.source ===
          identityEvidence.source,
    )
  ) {
    blockers.push(
      input.provider +
        " live authenticated discovery evidence is missing.",
    );
  }

  if (
    input.environment.resources.length ===
    0
  ) {
    blockers.push(
      "Live provider discovery returned no resources.",
    );
  }

  if (
    mockObserved(
      input.environment,
    )
  ) {
    blockers.push(
      "Mock or fixture evidence cannot satisfy real provider qualification.",
    );
  }

  if (
    input.validationResults.length ===
      0 ||
    input.validationResults.some(
      (result) =>
        !result.ok ||
        result.blocked === true,
    )
  ) {
    blockers.push(
      "Provider preview validation did not complete successfully.",
    );
  }

  if (
    input.preview.tool !==
    expectedPreviewTool(
      input.provider,
    )
  ) {
    blockers.push(
      "Provider qualification used the wrong preview adapter.",
    );
  }

  if (
    !input.preview.ok ||
    input.preview.blocked === true
  ) {
    blockers.push(
      "Governed provider preview did not complete successfully.",
    );
  }

  if (
    !input.preview.stdout.trim()
  ) {
    blockers.push(
      "Governed provider preview returned no evidence payload.",
    );
  }

  if (
    !input.preview.command ||
    input.preview.command.length === 0
  ) {
    blockers.push(
      "Governed provider preview command evidence is missing.",
    );
  } else if (
    dangerousPreviewCommand(
      input.preview,
    )
  ) {
    blockers.push(
      "Provider preview command crossed the non-mutating qualification boundary.",
    );
  }

  if (
    input.actEnabled !== false
  ) {
    blockers.push(
      "Infrastructure ACT must remain disabled during provider qualification.",
    );
  }

  const snapshotSha256 =
    sha256(
      JSON.stringify(
        input.environment,
      ),
    );

  return {
    schemaVersion: 1,
    sourceCommit:
      input.sourceCommit,
    provider: input.provider,
    ready:
      blockers.length === 0,
    ...(input.identity.mode
      ? {
          identityMode:
            input.identity.mode,
        }
      : {}),
    discovery: {
      classification:
        input.environment
          .classification,
      controlPlane:
        input.environment
          .controlPlane,
      resourceCount:
        input.environment
          .resources.length,
      evidenceKeys:
        input.environment.evidence
          .map((item) => item.key)
          .sort(),
      evidenceSources: [
        ...new Set(
          input.environment.evidence
            .map(
              (item) =>
                item.source,
            ),
        ),
      ].sort(),
      snapshotSha256,
    },
    validation: {
      passed:
        input.validationResults
          .length > 0 &&
        input.validationResults.every(
          (result) =>
            result.ok &&
            result.blocked !== true,
        ),
      tools: [
        ...new Set(
          input.validationResults.map(
            (result) =>
              result.tool,
          ),
        ),
      ].sort(),
    },
    preview: {
      tool: input.preview.tool,
      commandClass:
        commandClass(
          input.provider,
        ),
      durationMs:
        input.preview.durationMs,
      outputSha256:
        sha256(
          input.preview.stdout,
        ),
    },
    actEnabled: false,
    blockers: [
      ...new Set(
        blockers,
      ),
    ],
  };
}
